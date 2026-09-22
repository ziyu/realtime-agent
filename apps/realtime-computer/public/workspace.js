const form = document.querySelector('#record-form');
const saved = document.querySelector('#saved');
const dialog = document.querySelector('#notice');
form.dataset.document = crypto.randomUUID();
let layout = 0, slow = false;
const reviseLayout = () => {
  form.dataset.layout = String(++layout);
  document.querySelectorAll('[data-agent-target]').forEach(element => { element.dataset.version = String(layout); });
};
document.querySelector('[data-agent-target="dismiss"]').addEventListener('click', () => { dialog.close(); reviseLayout(); });
document.querySelector('[data-scenario="popup"]').addEventListener('click', () => { dialog.showModal(); reviseLayout(); });
document.querySelector('[data-scenario="shuffle"]').addEventListener('click', () => {
  const fields = document.querySelector('#fields'); fields.append(fields.firstElementChild); reviseLayout();
});
document.querySelector('[data-scenario="slow"]').addEventListener('click', () => {
  slow = !slow; document.querySelector('#speed-status').textContent = slow ? '慢保存（便于测试途中改口）' : '普通保存';
});
form.addEventListener('submit', event => {
  event.preventDefault();
  if (form.dataset.saving === 'true') return;
  const data = Object.fromEntries(new FormData(form));
  form.dataset.saving = 'true';
  const button = document.querySelector('[data-agent-target="save"]'); button.disabled = true;
  document.querySelector('#save-status').textContent = '正在保存…';
  setTimeout(() => {
    for (const [field, value] of Object.entries(data)) saved.querySelector(`[data-saved="${field}"]`).textContent = String(value);
    saved.dataset.version = String(Number(saved.dataset.version) + 1);
    form.dataset.saving = 'false'; button.disabled = false;
    document.querySelector('#save-status').textContent = '记录已保存';
  }, slow ? 1200 : 150);
});
