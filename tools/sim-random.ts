/**
 * Runs many random fights in parallel (one worker thread per CPU core) and
 * prints win rates per Pokemon and per item.
 *
 * Both teams get the same number of units, about the same gold budget (units are
 * priced like in the shop: rarity cost, x3 per evolution stage) and the same number
 * of items, so win rates are comparable. Pokemon are ranked against other Pokemon
 * of the same cost.
 *
 * Usage: npx tsx tools/sim-random.ts [nbFights=2000] [units=6] [budget=30] [nbItems=3] [nbWorkers=cpus]
 */
import { cpus } from "node:os"
import {
  Worker,
  isMainThread,
  parentPort,
  workerData
} from "node:worker_threads"
import { RarityCost } from "../app/config"
import { getPokemonData } from "../app/models/precomputed/precomputed-pokemon-data"
import { PRECOMPUTED_POKEMONS_PER_RARITY } from "../app/models/precomputed/precomputed-rarity"
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
type Params = { units: number; budget: number; nbItems: number }
type PoolEntry = { pkm: Pkm; cost: number }

const MAX_ITEMS_PER_UNIT = 3
const BUDGET_TOLERANCE = 2 // gold below the budget that still counts as "spent"

function pick<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)]
}

// unit value in gold: a 2-star is 3 copies of its 1-star, a 3-star is 9 copies
function unitCost(pkm: Pkm): number {
  const { rarity, stars } = getPokemonData(pkm)
  return RarityCost[rarity] * 3 ** (stars - 1)
}

function buildPool(): PoolEntry[] {
  const rarities = [Rarity.COMMON, Rarity.UNCOMMON, Rarity.RARE, Rarity.EPIC]
  return rarities
    .flatMap((r) => PRECOMPUTED_POKEMONS_PER_RARITY[r] ?? [])
    .filter((p) => {
      const data = getPokemonData(p)
      return !data.additional && !data.regional
    })
    .map((pkm) => ({ pkm, cost: unitCost(pkm) }))
}

// Picks exactly `units` units whose total cost is in [budget - tolerance, budget]
function pickUnits(pool: PoolEntry[], { units, budget }: Params): Pkm[] {
  const minCost = Math.min(...pool.map((e) => e.cost))
  for (let attempt = 0; attempt < 50; attempt++) {
    const chosen: PoolEntry[] = []
    let remaining = budget
    for (let i = 0; i < units; i++) {
      const slotsAfter = units - i - 1
      const maxCost = remaining - slotsAfter * minCost
      const isLast = slotsAfter === 0
      const candidates = pool.filter(
        (e) =>
          e.cost <= maxCost &&
          (!isLast || e.cost >= remaining - BUDGET_TOLERANCE)
      )
      if (candidates.length === 0) break
      const entry = pick(candidates)
      chosen.push(entry)
      remaining -= entry.cost
    }
    if (chosen.length === units) return chosen.map((e) => e.pkm)
  }
  throw new Error(`Cannot build ${units} units within a budget of ${budget}`)
}

function randomBoard(pool: PoolEntry[], params: Params): BoardSpec {
  const pkms = pickUnits(pool, params)
  // free cells on the 8x3 front area (y = 1..3)
  const cells: Array<[number, number]> = []
  for (let y = 1; y <= 3; y++) for (let x = 0; x < 8; x++) cells.push([x, y])
  const board: BoardSpec = pkms.map((pkm) => {
    const [x, y] = cells.splice(Math.floor(Math.random() * cells.length), 1)[0]
    return [pkm, x, y, [] as Item[]]
  })
  // same number of items on every team, spread over random units
  for (let i = 0; i < params.nbItems; i++) {
    const holders = board.filter((u) => (u[3]?.length ?? 0) < MAX_ITEMS_PER_UNIT)
    if (holders.length === 0) break
    pick(holders)[3]!.push(pick(CraftableItems))
  }
  return board
}

function bump(counter: Counter, key: string, won: boolean) {
  const entry = (counter[key] ??= { used: 0, won: 0 })
  entry.used++
  if (won) entry.won++
}

function work(nbFights: number, params: Params): WorkerResult {
  const pool = buildPool()
  const result: WorkerResult = {
    fights: 0,
    draws: 0,
    pokemon: {},
    items: {},
    durationSumMs: 0
  }
  for (let i = 0; i < nbFights; i++) {
    const blue = randomBoard(pool, params)
    const red = randomBoard(pool, params)
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

type Row = { name: string; used: number; rate: number; delta: number; cost?: number }

function printRows(title: string, rows: Row[], showCost: boolean) {
  const fmt = (r: Row) =>
    `  ${r.name.padEnd(22)}${showCost ? ` cost ${String(r.cost).padStart(2)}` : ""} ` +
    `${(r.rate * 100).toFixed(1).padStart(5)}%  ` +
    `(${r.delta >= 0 ? "+" : ""}${(r.delta * 100).toFixed(1)} pts, ${r.used} uses)`
  console.log(`\n${title} - best 8`)
  rows.slice(0, 8).forEach((r) => console.log(fmt(r)))
  console.log(`${title} - worst 8`)
  rows.slice(-8).forEach((r) => console.log(fmt(r)))
}

// Pokemon: delta = win rate minus the average win rate of Pokemon with the same cost
function rankPokemon(counter: Counter, minUsed: number) {
  const buckets: Record<number, { used: number; won: number }> = {}
  for (const [name, c] of Object.entries(counter)) {
    const b = (buckets[unitCost(name as Pkm)] ??= { used: 0, won: 0 })
    b.used += c.used
    b.won += c.won
  }
  const rows: Row[] = Object.entries(counter)
    .filter(([, c]) => c.used >= minUsed)
    .map(([name, c]) => {
      const cost = unitCost(name as Pkm)
      const baseline = buckets[cost].won / buckets[cost].used
      return { name, cost, used: c.used, rate: c.won / c.used, delta: c.won / c.used - baseline }
    })
    .sort((a, b) => b.delta - a.delta)
  printRows("Pokemon vs same-cost average", rows, true)
}

// Items: delta = win rate minus 50%, the expected rate for a neutral item
function rankItems(counter: Counter, minUsed: number) {
  const rows: Row[] = Object.entries(counter)
    .filter(([, c]) => c.used >= minUsed)
    .map(([name, c]) => ({
      name,
      used: c.used,
      rate: c.won / c.used,
      delta: c.won / c.used - 0.5
    }))
    .sort((a, b) => b.delta - a.delta)
  printRows("Items vs 50%", rows, false)
}

async function main() {
  const nbFights = Number(process.argv[2] ?? 2000)
  const params: Params = {
    units: Number(process.argv[3] ?? 6),
    budget: Number(process.argv[4] ?? 30),
    nbItems: Number(process.argv[5] ?? 3)
  }
  const nbWorkers = Number(process.argv[6] ?? cpus().length)
  const perWorker = Math.ceil(nbFights / nbWorkers)

  const start = performance.now()
  const results = await Promise.all(
    Array.from(
      { length: nbWorkers },
      () =>
        new Promise<WorkerResult>((resolve, reject) => {
          const worker = new Worker(__filename, {
            execArgv: ["--import", "tsx"],
            workerData: { nbFights: perWorker, params }
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
    `${total.fights} fights (${params.units} units, ~${params.budget} gold, ${params.nbItems} items per team) ` +
      `on ${nbWorkers} workers in ${seconds.toFixed(1)}s -> ${(total.fights / seconds).toFixed(0)} fights/s`
  )
  console.log(
    `draws: ${total.draws}, average fight length: ${(total.durationSumMs / total.fights / 1000).toFixed(1)}s of game time`
  )
  rankPokemon(total.pokemon, 30)
  rankItems(total.items, 30)
  process.exit(0)
}

if (isMainThread) {
  main()
} else {
  const { nbFights, params } = workerData as {
    nbFights: number
    params: Params
  }
  parentPort!.postMessage(work(nbFights, params))
}
