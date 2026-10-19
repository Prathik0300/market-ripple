// What a user can say they are into, and what each choice means on the map. One list for onboarding, Settings,
// the API and the main page; the ids match the check in supabase/migrations/20261019000400_interests.sql.
//
//   nodes    map node ids (knowledge/graph.json, predictor/config.py PROXIES): the events, model signals and news
//            pressure that touch these belong to the area
//   factors  the exposure factors in focus/latest and screen/latest (oil, gold, semis ...): a focus name whose
//            measured exposures include one of these belongs to the area
//   classes  asset classes, the sections of focus/latest plus funds: every focus name in that class, and every
//            single-name fact whose symbol is of that class, belongs to the area
//   tags     the facts store's source subjects (india-official, fed-register ...)

export type AssetClass = "us" | "india" | "commodities" | "crypto" | "funds";

export type Interest = {
  id: string;
  label: string;
  blurb: string;
  nodes: string[];
  factors: string[];
  classes: AssetClass[];
  tags: string[];
};

export const INTERESTS: Interest[] = [
  {
    id: "crypto", label: "Crypto", blurb: "Bitcoin, ether, coins and crypto-linked stocks",
    nodes: ["crypto_reg", "bitcoin", "ether", "crypto_stocks"],
    factors: ["bitcoin"], classes: ["crypto"], tags: [],
  },
  {
    id: "energy", label: "Oil & energy", blurb: "Crude, gas, fuels, uranium, tankers and producers",
    nodes: ["gulf_war", "opec_cut", "sanctions", "red_sea", "brent", "jet_fuel", "ttf", "hh", "lpg", "uranium",
      "freight", "oil_majors", "india_omc", "tankers", "container", "lng_export", "uranium_miners", "nuclear_smr", "f_oil", "f_gas", "f_uranium"],
    factors: ["oil", "gasoline", "diesel", "gas_us", "gas_eu", "uranium"], classes: [], tags: [],
  },
  {
    id: "metals", label: "Metals & mining", blurb: "Gold, silver, copper, aluminium, steel, lithium, rare earths",
    nodes: ["china_controls", "producer_ban", "gold", "silver", "copper", "aluminium", "nickel", "lithium", "rare_earths",
      "steel", "can_sheet", "gold_miners", "copper_miners", "alu_producers", "lithium_miners", "re_miners", "steel_cos",
      "f_gold", "f_silver", "f_copper", "f_lithium", "f_rare"],
    factors: ["gold", "silver", "platinum", "palladium", "copper", "aluminium", "steel", "lithium"], classes: [], tags: [],
  },
  {
    id: "tech", label: "Tech & semis", blurb: "AI chips, memory, hyperscalers, devices, Indian IT",
    nodes: ["ai_capex", "china_controls", "us_tariffs", "dram", "helium", "ai_chips", "memory", "hyperscalers", "devices",
      "indian_it", "f_semis"],
    factors: ["semis"], classes: [], tags: [],
  },
  {
    id: "agri", label: "Agriculture", blurb: "Grains, soft commodities, fertiliser and food companies",
    nodes: ["weather", "producer_ban", "import_rules", "urea", "phosphate", "sulphur", "wheat", "rice", "palm_oil", "soybeans",
      "cocoa", "coffee", "fertilizer", "chocolate", "coffee_chains", "ag_traders", "beverages", "f_agri"],
    factors: ["wheat", "corn", "soybeans", "soyoil", "rice", "sugar", "coffee", "cocoa", "cotton", "cattle", "hogs", "ojuice"],
    classes: [], tags: ["weather"],
  },
  {
    id: "mutual_funds", label: "Mutual funds", blurb: "Funds and ETFs: India equity, gold, bonds, sector funds",
    nodes: ["f_india", "f_gold", "f_silver", "f_bonds", "f_oil", "f_copper", "f_uranium", "f_lithium", "f_rare", "f_defense",
      "f_semis", "f_agri", "f_jets", "f_gas", "inr", "risk_on"],
    factors: [], classes: ["funds"], tags: [],
  },
  {
    id: "us_stocks", label: "US stocks", blurb: "S&P 500 mood, the Fed, tariffs and US sectors",
    nodes: ["risk_on", "consumer", "inflation", "fed_hike", "us_tariffs", "us_yields", "homebuilders", "autos", "airlines"],
    factors: [], classes: ["us"], tags: ["fed-register"],
  },
  {
    id: "india_stocks", label: "Indian stocks", blurb: "Nifty names, the rupee, fuel retailers, paints, IT",
    nodes: ["inr", "em_fx", "election_reform", "f_india", "india_omc", "india_paints", "indian_it"],
    factors: ["rupee"], classes: ["india"], tags: ["india-official"],
  },
  {
    id: "rates_fx", label: "Rates & currencies", blurb: "Treasury yields, the dollar, rupee, yen, central banks",
    nodes: ["fed_hike", "inflation", "japan_fiscal", "us_yields", "usd", "inr", "jpy", "em_fx", "f_bonds"],
    factors: ["rates", "dollar", "euro", "yuan", "rupee", "yen"], classes: [], tags: ["india-official", "fed-register"],
  },
  {
    id: "defense", label: "Defense", blurb: "Wars, sanctions, defence contractors and funds",
    nodes: ["gulf_war", "russia_war", "red_sea", "sanctions", "defense", "f_defense"],
    factors: ["defense", "gpr"], classes: [], tags: [],
  },
];

// Map node names (knowledge/graph.json), for the main page's labels.
export const NODE_LABELS: Record<string, string> = {
  gulf_war: "Gulf war / Hormuz threat", russia_war: "Russia-Ukraine escalation", red_sea: "Red Sea / Suez attacks",
  us_tariffs: "US tariff hike", china_controls: "China export controls", opec_cut: "OPEC+ output cut",
  sanctions: "Sanctions on a producer", fed_hike: "Fed hawkish surprise", ai_capex: "AI capex boom",
  producer_ban: "Producer export ban", weather: "Drought / El Ni\u00f1o / heat",
  pandemic: "Pandemic / demand collapse", import_rules: "Import quality rules",
  crypto_reg: "Crypto-friendly regulation", japan_fiscal: "Japan fiscal expansion",
  election_reform: "Market-friendly election result", inflation: "Inflation (CPI)", us_yields: "US Treasury yields",
  usd: "US dollar", risk_on: "Risk appetite", freight: "Freight & war-risk insurance", inr: "Indian rupee",
  jpy: "Japanese yen", em_fx: "EM importer currencies", consumer: "Consumer spending power",
  brent: "Crude oil (Brent)", jet_fuel: "Jet fuel & diesel", ttf: "Europe gas (TTF)", hh: "US gas (Henry Hub)",
  lpg: "LPG", gold: "Gold", silver: "Silver", copper: "Copper", aluminium: "Aluminium", nickel: "Nickel",
  lithium: "Lithium", rare_earths: "Rare earths & magnets", uranium: "Uranium", steel: "Steel",
  sulphur: "Sulphur & sulphuric acid", urea: "Nitrogen fertiliser (urea)", phosphate: "Phosphate (DAP)",
  helium: "Helium", wheat: "Wheat", rice: "Rice", palm_oil: "Vegetable oils", soybeans: "Soybeans", cocoa: "Cocoa",
  coffee: "Coffee", dram: "Memory chips (DRAM/HBM)", can_sheet: "Can sheet & cans", oil_majors: "Oil producers",
  india_omc: "Indian fuel retailers", airlines: "Airlines", tankers: "Oil tankers", container: "Container lines",
  defense: "Defence contractors", gold_miners: "Gold miners", copper_miners: "Copper miners",
  alu_producers: "Aluminium producers", beverages: "Beverages & can makers", fertilizer: "Fertiliser makers",
  eu_chem: "European chemicals", lng_export: "US LNG & gas exporters", uranium_miners: "Uranium miners",
  lithium_miners: "Lithium miners", re_miners: "Rare-earth producers", ai_chips: "AI chipmakers",
  memory: "Memory makers", hyperscalers: "Hyperscalers", devices: "PC & phone makers", autos: "Automakers",
  chocolate: "Chocolate makers", india_paints: "Indian paints & tyres", industrial_gas: "Industrial gas suppliers",
  nuclear_smr: "Nuclear & SMR stocks", indian_it: "Indian IT exporters", jp_exporters: "Japanese exporters",
  homebuilders: "US homebuilders", crypto_stocks: "Crypto-linked stocks", coffee_chains: "Coffee chains & roasters",
  ag_traders: "Grain traders", steel_cos: "Steelmakers", f_oil: "Oil funds", f_gold: "Gold funds",
  f_silver: "Silver funds", f_copper: "Copper funds", f_uranium: "Uranium funds",
  f_lithium: "Lithium & battery funds", f_rare: "Rare-earth funds", f_defense: "Defence funds",
  f_semis: "Semiconductor funds", f_agri: "Agriculture funds", f_bonds: "Long Treasury funds",
  f_jets: "Airline fund", f_gas: "US natural gas fund", f_india: "India equity funds", bitcoin: "Bitcoin",
  ether: "Ether",
};

export const INTEREST_IDS = INTERESTS.map((i) => i.id) as [string, ...string[]];

const BY_ID = new Map(INTERESTS.map((i) => [i.id, i]));

/** Keep only known ids, in the list's own order, without repeats. */
export function cleanInterests(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const want = new Set(ids.filter((x): x is string => typeof x === "string"));
  return INTERESTS.filter((i) => want.has(i.id)).map((i) => i.id);
}

/** Everything the chosen interests cover, as sets for quick matching. */
export function areaOf(ids: string[]) {
  const picked = ids.map((id) => BY_ID.get(id)).filter((i): i is Interest => !!i);
  const all = <T,>(f: (i: Interest) => T[]) => new Set(picked.flatMap(f));
  return { picked, nodes: all((i) => i.nodes), factors: all((i) => i.factors), classes: all((i) => i.classes), tags: all((i) => i.tags) };
}
export type Area = ReturnType<typeof areaOf>;

// coins the facts store and focus list name by bare symbol (focus/latest crypto section, predictor/config.py)
const COINS = new Set(["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "DOT", "AVAX", "LINK", "LTC", "BCH", "HBAR", "TRX", "XLM",
  "SHIB", "UNI", "MATIC", "POL", "ATOM", "NEAR", "APT", "SUI", "TON", "BNB", "ETC", "FIL", "ARB", "OP", "PEPE"]);

/** The asset class of a single-name subject (a ticker, a coin, an AMFI fund code). `company` is set when the subject is
 *  known to be a company (filings, earnings), so a ticker such as BCH (Banco de Chile) is not read as a coin. */
export function classOfSymbol(sym: string, company = false): AssetClass {
  if (/^MF_/.test(sym)) return "funds";
  if (/\.(NS|BO)$/.test(sym)) return "india";
  if (!company && (COINS.has(sym) || /-USD$/.test(sym))) return "crypto";
  return "us";
}
