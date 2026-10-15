/**
 * Line-based JSON server that exposes PacEnv to other languages (see python/pac_env.py).
 *
 * Requests (one JSON object per line on stdin):
 *   {"cmd":"info"}
 *   {"cmd":"reset"}
 *   {"cmd":"step","action":{"type":"buy","index":0}}
 *   {"cmd":"close"}
 *
 * Responses are written to stdout as "@@" + JSON, one per line. Everything else the
 * game prints to stdout (timings, warnings) must be ignored by the client.
 *
 * Usage: node --import tsx tools/env-server.ts
 */
import { createInterface } from "node:readline"
import { SHOP_SIZE } from "../app/config"
import { Pkm } from "../app/types/enum/Pokemon"
import { Synergy } from "../app/types/enum/Synergy"
import { type Action, PacEnv } from "./pac-env"

type Request =
  | { cmd: "info" }
  | { cmd: "reset" }
  | { cmd: "step"; action: Action }
  | { cmd: "close" }

let env: PacEnv | undefined

function send(message: unknown) {
  process.stdout.write(`@@${JSON.stringify(message)}\n`)
}

async function handle(request: Request) {
  switch (request.cmd) {
    case "info":
      // stable vocabularies, so clients can turn names into integer ids
      send({
        pkmNames: Object.values(Pkm),
        synergyNames: Object.values(Synergy),
        shopSize: SHOP_SIZE
      })
      break
    case "reset": {
      if (env) await env.reset()
      else env = await PacEnv.create()
      send({
        observation: env.observation(),
        legalActions: env.legalActions(),
        reward: 0,
        done: false
      })
      break
    }
    case "step": {
      if (!env) throw new Error("Call reset first")
      const { observation, reward, done } = env.step(request.action)
      send({ observation, reward, done, legalActions: env.legalActions() })
      break
    }
    case "close":
      process.exit(0)
  }
}

// Requests are handled one at a time, in order
let queue: Promise<void> = Promise.resolve()
const rl = createInterface({ input: process.stdin })
rl.on("line", (line) => {
  queue = queue.then(async () => {
    try {
      await handle(JSON.parse(line) as Request)
    } catch (error) {
      send({ error: String(error instanceof Error ? error.stack : error) })
    }
  })
})
rl.on("close", () => process.exit(0))

send({ ready: true })
