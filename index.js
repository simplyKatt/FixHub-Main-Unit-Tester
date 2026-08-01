#!/usr/bin/env node
/**
 * fixhub-diag
 * ===========
 * A small serial diagnostic tool for the iFixit FixHub Power Station.
 *
 * It runs a fixed sequence of read-only commands from the FixHub CLI
 * (documented at https://github.com/iFixit/FixHub/blob/main/README.md)
 * and prints each response cleanly, one command per prompt.
 *
 * Originally written to chase a "front port stops recognizing the iron"
 * fault: `usbpd summary` / `usbpd status` / `toolcomms` turned out to
 * report identical, unchanging values regardless of what was actually
 * plugged into TOOLPORT1/TOOLPORT2 — including with nothing connected
 * at all. Kept general enough to be useful for other boot/comms/power
 * issues on this device too.
 *
 * Usage:
 *   npm install
 *   node fixhub-diag.js --list                 # find the serial port
 *   node fixhub-diag.js <port> [baudRate]       # run diagnostics
 *
 * Examples:
 *   node fixhub-diag.js /dev/tty.usbmodemXXXX
 *   node fixhub-diag.js COM5 115200
 *
 * All commands here are read-only against the device. Nothing in
 * COMMANDS resets, clears, or writes device state.
 */

'use strict';

const { SerialPort } = require('serialport');

/** Commands to run, in order. Add/remove freely — see README.md in the
 *  FixHub repo for the full command set (gpio, i2c, adc, etc. are
 *  intentionally left out here since they can alter device state). */
const COMMANDS = [
  'version',
  'hwid get',
  'pwrsrc get',
  'uptime',
  'toolcomms',
  'comms g0version',
  'usbpd summary',
  'usbpd status',
  'errorlog', // read-only invocation; does NOT run "errorlog clear"
];

const PROMPT = 'ifixitl5:~$';
const PER_COMMAND_TIMEOUT_MS = 5000; // fallback if the prompt never reappears
const OVERALL_TIMEOUT_MS = 60000;

function printUsage() {
  const script = require('path').basename(__filename);
  console.log(`Usage:\n  node ${script} --list\n  node ${script} <port> [baudRate=115200]`);
}

async function listPorts() {
  let ports;
  try {
    ports = await SerialPort.list();
  } catch (err) {
    console.error('Failed to list serial ports:', err.message);
    process.exitCode = 1;
    return;
  }

  if (ports.length === 0) {
    console.log('No serial ports found.');
    return;
  }

  console.log('Available serial ports:\n');
  for (const p of ports) {
    const manufacturer = p.manufacturer ? `  (${p.manufacturer})` : '';
    const ids = p.vendorId ? `  [${p.vendorId}:${p.productId || '????'}]` : '';
    console.log(`  ${p.path}${manufacturer}${ids}`);
  }
}

/**
 * Waits for `marker` to appear in `getBuffer()`, polling at a short
 * interval, up to `timeoutMs`. Resolves with whether the marker was
 * actually seen (false means it timed out instead).
 */
function waitForMarker(getBuffer, marker, timeoutMs) {
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      if (getBuffer().includes(marker)) {
        cleanup();
        resolve(true);
      }
    }, 50);
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    function cleanup() {
      clearInterval(poll);
      clearTimeout(timeout);
    }
  });
}

/** Strips the echoed command and trailing prompt out of a raw response. */
function extractResponse(raw, cmd) {
  let text = raw;

  const echoIdx = text.indexOf(cmd);
  if (echoIdx !== -1) text = text.slice(echoIdx + cmd.length);

  const promptIdx = text.lastIndexOf(PROMPT);
  if (promptIdx !== -1) text = text.slice(0, promptIdx);

  return text.replace(/\r/g, '').trim();
}

function indent(text) {
  return text
    .split('\n')
    .map((line) => '  ' + line)
    .join('\n');
}

async function runCommand(port, getBuffer, resetBuffer, cmd) {
  resetBuffer();
  console.log(`> ${cmd}`);

  await new Promise((resolve) => {
    port.write(cmd + '\r\n', (err) => {
      if (err) console.log(`  (write error: ${err.message})`);
      resolve();
    });
  });

  const sawPrompt = await waitForMarker(getBuffer, PROMPT, PER_COMMAND_TIMEOUT_MS);
  const response = extractResponse(getBuffer(), cmd);

  if (!sawPrompt && !response.length) {
    console.log('  (no response / prompt never returned — device may be stuck)');
  } else {
    console.log(response.length ? indent(response) : '  (no output)');
  }
  console.log('');

  return response;
}

function summarize(results) {
  console.log('=== Quick read ===');

  if (results.toolcomms) {
    console.log(
      'toolcomms shows Port1/Port2 as 0 (no active tool) or 1 (active\n' +
        'tool communicating). Compare against which physical port a tool\n' +
        'is actually plugged into.'
    );
  }

  const g0 = results['comms g0version'] || '';
  if (/timeout/i.test(g0) || /not subscribed/i.test(g0)) {
    console.log(
      '\ncomms g0version timed out — per the FixHub README this means\n' +
        '"Is the other MCU subscribed?", i.e. the second processor did\n' +
        'not answer at all.'
    );
  } else if (g0) {
    console.log(
      '\ncomms g0version got a response — the second processor is at\n' +
        'least answering on the inter-MCU comms bus.'
    );
  }

  if (results.errorlog && results.errorlog.trim()) {
    console.log('\nerrorlog returned content — see above for any faults the firmware logged on its own.');
  }

  console.log(
    '\nThis is raw device output only — no interpretation beyond what the\n' +
      "README documents. Tip: if a reading looks static across multiple\n" +
      'runs regardless of what you physically plug/unplug, rerun this a\n' +
      'few times under different physical states before trusting it — a\n' +
      'value that never changes may mean the sensor/port state itself\n' +
      "isn't being read live. Worth keeping the full log for a support ticket."
  );
}

async function runDiagnostics(portPath, baudRate) {
  const port = new SerialPort({ path: portPath, baudRate, autoOpen: false });
  const results = {};
  let buffer = '';

  port.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
  });
  port.on('error', (err) => {
    console.error('Serial port error:', err.message);
    process.exitCode = 1;
  });

  const overallTimeout = setTimeout(() => {
    console.error('\nTimed out waiting on the device overall. Closing.');
    port.close(() => process.exit(1));
  }, OVERALL_TIMEOUT_MS);

  await new Promise((resolve, reject) => {
    port.open((err) => (err ? reject(err) : resolve()));
  }).catch((err) => {
    console.error(`Could not open ${portPath}: ${err.message}`);
    process.exitCode = 1;
    clearTimeout(overallTimeout);
    process.exit(1);
  });

  console.log(`Connected to ${portPath} @ ${baudRate} baud\n`);

  // Let the boot banner / initial prompt settle before the first real command.
  await waitForMarker(() => buffer, PROMPT, PER_COMMAND_TIMEOUT_MS);
  buffer = '';

  for (const cmd of COMMANDS) {
    results[cmd] = await runCommand(
      port,
      () => buffer,
      () => (buffer = ''),
      cmd
    );
  }

  clearTimeout(overallTimeout);
  console.log('--- Done ---\n');
  summarize(results);
  port.close(() => process.exit(0));
}

// --- entry point ---
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  printUsage();
  process.exit(0);
} else if (args[0] === '--list') {
  listPorts();
} else {
  const portPath = args[0];
  const baudRate = args[1] ? parseInt(args[1], 10) : 115200;
  runDiagnostics(portPath, baudRate).catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
  });
}