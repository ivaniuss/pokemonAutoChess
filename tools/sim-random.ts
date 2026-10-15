/**
 * Runs many random fights in parallel (one worker thread per CPU core) and
 * prints win rates per Pokemon and per item.
 *
 * Usage: npx tsx tools/sim-random.ts [nbFights=2000] [teamSize=6] [nbWorkers=cpus]
 */
import { cpus } from "node:os"
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads"
import { PRECOMPUTED_POKEMONS_PER_RARITY } from "../app/models/precomputed/precomputed-rarity"
import { getPokemonData } from "../app/models/precomputed/precomputed-pokemon-data"
import { Rarity } from "../app/types/enum/Game"
import { CraftableItems, type Item } from "../app/types/enum/Item"
import type { Pkm } from "../app/types/enum/Pokemon"
import { type BoardSpec, runFight } from "./sim-battle"

type Counter = Record<string, { used: number; won: number }>
type WorkerResult = {
  fights: number
  draws: number
  pokemon: Counter
  items: Counter
  durationSumMs: number
}

const ITEM_CHANCE = 0.3 // probability that a unit holds an item
const MAX_ITEMS = 3

function pick<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)]
}

function buildPool(): Pkm[] {
  const rarities = [Rarity.COMMON, Rarity.UNCOMMON, Rarity.RARE, Rarity.EPIC]
  return rarities
    .flatMap((r) => PRECOMPUTED_POKEMONS_PER_RARITY[r] ?? [])
    .filter((p) => {
      const data = getPokemonData(p)
      return !data.additional && !data.regional
    })
}

function randomBoard(pool: Pkm[], teamSize: number): BoardSpec {
  // free cells on the 8x3 front area (y = 1..3)
  const cells: Array<[number, number]> = []
  for (let y = 1; y <= 3; y++) for (let x = 0; x < 8; x++) cells.push([x, y])
  const board: BoardSpec = []
  for (let i = 0; i < teamSize; i++) {
    const [x, y] = cells.splice(Math.floor(Math.random() * cells.length), 1)[0]
    const items: Item[] = []
    while (items.length < MAX_ITEMS && Math.random() < ITEM_CHANCE) {
      items.push(pick(CraftableItems))
    }
    board.push([pick(pool), x, y, items])
  }
  return board
}

function bump(counter: Counter, key: string, won: boolean) {
  const entry = (counter[key] ??= { used: 0, won: 0 })
  entry.used++
  if (won) entry.won++
}

function work(nbFights: number, teamSize: number): WorkerResult {
  const pool = buildPool()
  const result: WorkerResult = {
    fights: 0,
    draws: 0,
    pokemon: {},
    items: {},
    durationSumMs: 0
  }
  for (let i = 0; i < nbFights; i++) {
    const blue = randomBoard(pool, teamSize)
    const red = randomBoard(pool, teamSize)
    const { winner, durationMs } = runFight(blue, red)
    result.fights++
    result.durationSumMs += durationMs
    if (winner === "draw") {
      result.draws++
      continue
    }
    for (const [board, side] of [
      [blue, "blue"],
      [red, "red"]
    ] as const) {
      for (const [pkm, , , items] of board) {
        bump(result.pokemon, pkm, winner === side)
        items?.forEach((item) => bump(result.items, item, winner === side))
      }
    }
  }
  return result
}

function merge(into: Counter, from: Counter) {
  for (const [key, { used, won }] of Object.entries(from)) {
    const entry = (into[key] ??= { used: 0, won: 0 })
    entry.used += used
    entry.won += won
  }
}

function printRanking(title: string, counter: Counter, minUsed: number) {
  const rows = Object.entries(counter)
    .filter(([, c]) => c.used >= minUsed)
    .map(([name, c]) => ({ name, used: c.used, rate: c.won / c.used }))
    .sort((a, b) => b.rate - a.rate)
  const fmt = (r: (typeof rows)[number]) =>
    `  ${r.name.padEnd(22)} ${(r.rate * 100).toFixed(1).padStart(5)}%  (${r.used} uses)`
  console.log(`\n${title} (min ${minUsed} uses) - best 8`)
  rows.slice(0, 8).forEach((r) => console.log(fmt(r)))
  console.log(`${title} - worst 8`)
  rows.slice(-8).forEach((r) => console.log(fmt(r)))
}

async function main() {
  const nbFights = Number(process.argv[2] ?? 2000)
  const teamSize = Number(process.argv[3] ?? 6)
  const nbWorkers = Number(process.argv[4] ?? cpus().length)
  const perWorker = Math.ceil(nbFights / nbWorkers)

  const start = performance.now()
  const results = await Promise.all(
    Array.from(
      { length: nbWorkers },
      () =>
        new Promise<WorkerResult>((resolve, reject) => {
          const worker = new Worker(__filename, {
            execArgv: ["--import", "tsx"],
            workerData: { nbFights: perWorker, teamSize }
          })
          worker.once("message", resolve)
          worker.once("error", reject)
        })
    )
  )
  const seconds = (performance.now() - start) / 1000

  const total: WorkerResult = {
    fights: 0,
    draws: 0,
    pokemon: {},
    items: {},
    durationSumMs: 0
  }
  for (const r of results) {
    total.fights += r.fights
    total.draws += r.draws
    total.durationSumMs += r.durationSumMs
    merge(total.pokemon, r.pokemon)
    merge(total.items, r.items)
  }

  console.log(
    `${total.fights} fights (${teamSize}v${teamSize}) on ${nbWorkers} workers in ${seconds.toFixed(1)}s -> ${(total.fights / seconds).toFixed(0)} fights/s`
  )
  console.log(
    `draws: ${total.draws}, average fight length: ${(total.durationSumMs / total.fights / 1000).toFixed(1)}s of game time`
  )
  printRanking("Pokemon win rate", total.pokemon, 30)
  printRanking("Item win rate", total.items, 30)
  process.exit(0)
}

if (isMainThread) {
  main()
} else {
  const { nbFights, teamSize } = workerData as {
    nbFights: number
    teamSize: number
  }
  parentPort!.postMessage(work(nbFights, teamSize))
}
