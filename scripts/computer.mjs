#!/usr/bin/env node
import { main } from '../apps/realtime-computer/scripts/computer-cli.mjs';
process.exitCode = await main();
