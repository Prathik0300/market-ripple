// The investing platforms a user can connect, and exactly which fields each one takes.
const FN = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/functions/v1/sync`;

export type ProviderId = "groww" | "coindcx" | "zerodha" | "upstox" | "binance";
export type Provider = {
  id: ProviderId;
  name: string;
  what: string;
  fields: { key: string; label: string; secret: boolean }[];
  steps: string[];
  note?: string;
  login?: boolean;            // needs a daily sign-in with the broker (Zerodha, Upstox)
};

export const loginRedirect = (id: ProviderId) => `${FN}/oauth/${id}`;

export const PROVIDERS: Provider[] = [
  {
    id: "groww", name: "Groww", what: "Indian stocks and ETFs in your demat account",
    fields: [{ key: "api_key", label: "API key", secret: false }, { key: "api_secret", label: "API secret", secret: true }],
    steps: [
      "In Groww, open Profile › Settings › Trading APIs and turn them on (the free plan is enough).",
      "On groww.in/trade-api/api-keys, create an API key and secret, and paste both below.",
      "Each day after 6:00 AM India time, approve the key on that same page.",
    ],
    note: "Groww's API has no mutual funds; they come from a CAMS statement instead.",
  },
  {
    id: "zerodha", name: "Zerodha", what: "Kite holdings and today's trades", login: true,
    fields: [{ key: "api_key", label: "API key", secret: false }, { key: "api_secret", label: "API secret", secret: true }],
    steps: [
      "Create an app on developers.kite.trade (the Personal plan is enough for holdings).",
      `Set its redirect URL to ${loginRedirect("zerodha")}`,
      "Paste the app's API key and secret below, then press Log in with Zerodha once a day.",
    ],
  },
  {
    id: "upstox", name: "Upstox", what: "Long-term holdings and today's trades", login: true,
    fields: [{ key: "api_key", label: "API key (client id)", secret: false }, { key: "api_secret", label: "API secret", secret: true }],
    steps: [
      "Create an app at account.upstox.com/developer/apps.",
      `Set its redirect URL to ${loginRedirect("upstox")}`,
      "Paste the API key and secret below, then press Log in with Upstox once a day.",
    ],
  },
  {
    id: "coindcx", name: "CoinDCX", what: "Crypto balances and your trade history",
    fields: [{ key: "api_key", label: "API key", secret: false }, { key: "api_secret", label: "API secret", secret: true }],
    steps: [
      "In CoinDCX, open Profile › API Dashboard › Create a new one (it asks for OTPs).",
      "Do not bind it to one IP address: the cloud sync's address changes.",
      "Copy the secret before leaving the page (CoinDCX shows it once), and paste both below.",
    ],
  },
  {
    id: "binance", name: "Binance", what: "Crypto balances, with a read-only key",
    fields: [{ key: "api_key", label: "API key", secret: false }, { key: "api_secret", label: "Secret key", secret: true }],
    steps: [
      "In Binance, open Account › API Management › Create API (system generated).",
      "Leave only \"Enable Reading\" ticked. A key that can trade or withdraw is refused.",
      "Paste the API key and secret key below.",
    ],
  },
];

export const providerById = (id: string) => PROVIDERS.find((p) => p.id === id);
