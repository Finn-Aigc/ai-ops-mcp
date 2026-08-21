import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

let muted = false;
const sink = new Writable({
  write(chunk, _encoding, callback) {
    if (!muted) process.stdout.write(chunk);
    callback();
  },
});
let terminal: ReturnType<typeof createInterface> | undefined;
let pipedLines: Promise<string[]> | undefined;

async function nextPipedLine(): Promise<string> {
  pipedLines ??= (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
  })();
  return (await pipedLines).shift() ?? "";
}

function getTerminal(): ReturnType<typeof createInterface> {
  terminal ??= createInterface({
    input: process.stdin,
    output: sink,
    terminal: process.stdin.isTTY === true,
  });
  return terminal;
}

export async function promptText(label: string, defaultValue?: string): Promise<string> {
  muted = false;
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  process.stdout.write(`${label}${suffix}: `);
  const value = (process.stdin.isTTY === true
    ? await getTerminal().question("")
    : await nextPipedLine()).trim();
  return value || defaultValue || "";
}

export async function promptSecret(label: string): Promise<string> {
  process.stdout.write(`${label}: `);
  muted = true;
  try {
    const value = process.stdin.isTTY === true
      ? await getTerminal().question("")
      : await nextPipedLine();
    process.stdout.write("\n");
    return value;
  } finally {
    muted = false;
  }
}

export async function confirm(label: string): Promise<boolean> {
  const answer = (await promptText(`${label} [y/N]`)).toLowerCase();
  return answer === "y" || answer === "yes";
}

export function closePrompts(): void {
  terminal?.close();
  terminal = undefined;
  pipedLines = undefined;
  muted = false;
}
