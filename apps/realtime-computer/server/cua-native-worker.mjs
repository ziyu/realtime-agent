import { createInterface } from 'node:readline';
import { ActionCompletion, CuaDriver, DriverError } from '@trycua/cua-driver';

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_TEXT_CHARS = 1024 * 1024;
const MAX_DATA_CHARS = 8 * 1024 * 1024;
const MAX_IMAGE_BASE64_CHARS = 24 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

let driver;
let closed = false;
let active = null;

function safeCode(error) {
  for (const value of [error?.errorCode, error?.code, error?.inner?.code, error?.tag]) {
    if (typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value)) return value;
  }
  return 'cua_native_error';
}

function safeMessage(error) {
  const message = typeof error?.message === 'string' ? error.message : 'Cua Driver could not complete the request.';
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}

function interruptedCompletion(error) {
  try {
    if (!DriverError.ActionInterrupted.instanceOf(error)) return undefined;
    const completion = DriverError.ActionInterrupted.getInner(error).completion;
    if (completion === ActionCompletion.NotStarted || completion === ActionCompletion.Completed || completion === ActionCompletion.Unknown) return completion;
  } catch { }
  return undefined;
}

function parseJson(text) {
  if (typeof text !== 'string' || !text.length) return null;
  if (text.length > MAX_DATA_CHARS) throw Object.assign(new Error('Cua Driver structured output exceeded its limit.'), { code: 'cua_output_too_large' });
  return JSON.parse(text);
}

function normalizedResult(result) {
  const text = typeof result?.text === 'string' ? result.text.slice(0, MAX_TEXT_CHARS) : '';
  const structured = typeof result?.structuredJson === 'string' && result.structuredJson.length ? result.structuredJson
    : typeof result?.rawJson === 'string' && result.rawJson.length ? result.rawJson : '';
  const data = structured ? parseJson(structured) : null;
  const images = Array.isArray(result?.images) ? result.images.map(image => ({
    mimeType: typeof image?.mimeType === 'string' ? image.mimeType.slice(0, 120) : 'application/octet-stream',
    dataBase64: typeof image?.dataBase64 === 'string' ? image.dataBase64 : '',
  })) : [];
  let totalImageChars = 0;
  for (const image of images) {
    totalImageChars += image.dataBase64.length;
    if (totalImageChars > MAX_IMAGE_BASE64_CHARS) throw Object.assign(new Error('Cua Driver image output exceeded its limit.'), { code: 'cua_output_too_large' });
  }
  let verified;
  const status = result?.verification?.status;
  if (status === 0) verified = true;
  else if (status === 1) verified = false;
  return {
    text,
    data,
    images,
    isError: result?.isError === true,
    ...(typeof result?.errorCode === 'string' ? { errorCode: result.errorCode.slice(0, 120) } : {}),
    ...(verified === undefined ? {} : { verified }),
    degraded: result?.degraded === true,
  };
}

function write(message) {
  const json = JSON.stringify(message);
  if (Buffer.byteLength(json, 'utf8') > MAX_RESPONSE_BYTES) {
    const fallback = JSON.stringify({ id: message?.id ?? null, ok: false, error: { code: 'cua_output_too_large', message: 'Cua Driver response exceeded its transport limit.' } });
    process.stdout.write(`${fallback}\n`);
    return;
  }
  process.stdout.write(`${json}\n`);
}

async function shutdown() {
  if (closed) return;
  closed = true;
  try { active?.controller.abort(new Error('Cua transport is closing.')); } catch { }
  try { await driver?.shutdown(); } catch { }
  try { driver?.uniffiDestroy?.(); } catch { }
}

async function initialize() {
  driver = CuaDriver.create(undefined);
  const [metadata, toolsJson] = await Promise.all([driver.metadata(), driver.listToolsJson()]);
  const inventory = JSON.parse(toolsJson);
  write({ type: 'ready', metadata, inventory });
}

async function runCall(request) {
  if (closed) return;
  const id = request.id;
  if (active) {
    write({ id, ok: false, error: { code: 'cua_busy', message: 'A Cua Driver call is already active.' } });
    return;
  }
  const name = typeof request.name === 'string' ? request.name : '';
  if (!/^[a-z][a-z0-9_]{0,127}$/.test(name)) {
    write({ id, ok: false, error: { code: 'cua_invalid_tool', message: 'The Cua Driver tool name is invalid.' } });
    return;
  }
  let argsJson;
  try {
    argsJson = JSON.stringify(request.args ?? {});
    if (Buffer.byteLength(argsJson, 'utf8') > MAX_INPUT_BYTES) throw Object.assign(new Error('Cua Driver arguments exceeded their limit.'), { code: 'cua_input_too_large' });
  } catch (error) {
    write({ id, ok: false, error: { code: safeCode(error), message: safeMessage(error) } });
    return;
  }
  const controller = new AbortController();
  active = { id, controller };
  try {
    const result = await driver.callTool(name, argsJson, { signal: controller.signal });
    write({ id, ok: true, result: normalizedResult(result) });
  } catch (error) {
    const completion = interruptedCompletion(error);
    write({ id, ok: false, error: {
      code: completion === undefined && controller.signal.aborted ? 'cua_cancelled' : safeCode(error),
      message: completion === undefined && controller.signal.aborted ? 'The Cua Driver call was cancelled.' : safeMessage(error),
      ...(completion === undefined ? {} : { completion }),
    } });
  } finally {
    if (active?.id === id) active = null;
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  if (!line || closed) return;
  if (Buffer.byteLength(line, 'utf8') > MAX_INPUT_BYTES + 64 * 1024) {
    write({ id: null, ok: false, error: { code: 'cua_input_too_large', message: 'Cua transport request exceeded its limit.' } });
    return;
  }
  let request;
  try { request = JSON.parse(line); }
  catch { write({ id: null, ok: false, error: { code: 'cua_protocol', message: 'Cua transport received malformed JSON.' } }); return; }
  if (request?.kind === 'call') { void runCall(request); return; }
  if (request?.kind === 'cancel') {
    if (typeof request.id === 'string' && active?.id === request.id) active.controller.abort(new Error('Cancelled by parent transport.'));
    return;
  }
  if (request?.kind === 'close') { void shutdown().finally(() => process.exit(0)); return; }
  write({ id: request?.id ?? null, ok: false, error: { code: 'cua_protocol', message: 'Cua transport request kind is unsupported.' } });
});
lines.once('close', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });

initialize().catch(error => {
  write({ type: 'fatal', error: { code: safeCode(error), message: safeMessage(error) } });
  void shutdown().finally(() => process.exit(1));
});
