// Hosts the pinned upstream EJS bundle passed by the worker over stdin.
const write = Deno.stdout.write.bind(Deno.stdout);
const encode = new TextEncoder();
const prepared = new Map();
const maxPlayers = 4;
const maxLineChars = 8 * 1024 * 1024;
let solver;

async function reply(message) {
  const data = encode.encode(JSON.stringify(message) + "\n");
  for (let offset = 0; offset < data.length;) {
    offset += await write(data.subarray(offset));
  }
}

function execute(request) {
  if (request.action === "init" && !solver) {
    solver = Function(
      request.lib + "\nObject.assign(globalThis, lib);\n" + request.core + "\nreturn jsc;",
    )();
    if (typeof solver.prepare !== "function") throw new Error("incompatible solver");
    return { ready: true };
  }
  if (!solver || request.action !== "solve") throw new Error("invalid request");

  const hit = prepared.has(request.key);
  if (!hit && typeof request.player !== "string") return { miss: true };

  const started = performance.now();
  let functions;
  if (hit) {
    functions = prepared.get(request.key);
    prepared.delete(request.key);
  } else {
    // Restore the functions exactly as the bundled EJS solver does.
    functions = { n: null, sig: null };
    Function("_result", solver.prepare(request.player))(functions);
  }
  prepared.set(request.key, functions);
  if (prepared.size > maxPlayers) prepared.delete(prepared.keys().next().value);
  const prepareMs = performance.now() - started;
  const solveStarted = performance.now();
  const output = solver({
    type: "preprocessed",
    viewsicalFunctions: functions,
    requests: request.requests,
  });
  return { output, hit, prepareMs, solveMs: performance.now() - solveStarted };
}

let pending = "";
for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
  pending += chunk;
  let newline;
  while ((newline = pending.indexOf("\n")) !== -1) {
    if (newline > maxLineChars) Deno.exit(1);
    const request = JSON.parse(pending.slice(0, newline));
    pending = pending.slice(newline + 1);
    try {
      await reply({ id: request.id, ...execute(request) });
    } catch {
      await reply({ id: request.id, error: true });
    }
  }
  if (pending.length > maxLineChars) Deno.exit(1);
}
