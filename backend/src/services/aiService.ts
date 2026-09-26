import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error("GEMINI_API_KEY is not configured");
}

const ai = new GoogleGenAI({
  apiKey,
});

const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

export interface SaleSummaryInput {
  date: string;
  invoiceNumber: string;
  totalAmount: number;
  paymentMethod?: string;
}

export interface SalesData {
  shopName?: string;
  periodStart: string;
  periodEnd: string;
  sales: SaleSummaryInput[];
}

export interface InventoryItem {
  productId: string;
  name: string;
  sku?: string;
  currentStock: number;
  sellingPrice: number;
  lastSaleDate?: string | null;
  salesLast30Days: number;
}

export interface InventoryData {
  inventory: InventoryItem[];
}

export interface DailySummaryResult {
  bullets: [string, string, string];
}

export interface DeadStockItem {
  productId: string;
  name: string;
  sku?: string;
  currentStock: number;
  salesLast30Days: number;
}

export interface DeadStockResult {
  items: DeadStockItem[];
  summary: string;
}

const FORBIDDEN_MUTATION_KEYS = new Set([
  "balance",
  "outstanding_balance",
  "credit_balance",
  "stock",
  "current_stock",
  "quantity",
  "inventory",
  "total_amount",
  "amount",
  "selling_price",
  "purchase_price",
  "gst",
  "gst_percent",
  "version",
]);

function containsForbiddenMutation(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    return Array.from(FORBIDDEN_MUTATION_KEYS).some((key) => normalized.includes(key));
  }
  if (Array.isArray(value)) {
    return value.some(containsForbiddenMutation);
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, nestedValue]) =>
        FORBIDDEN_MUTATION_KEYS.has(key.toLowerCase()) || containsForbiddenMutation(nestedValue)
    );
  }
  return false;
}

function extractJson(text: string): unknown {
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Gemini returned invalid JSON");
    }
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

export async function generateDailySummary(salesData: SalesData): Promise<DailySummaryResult> {
  const sanitizedSales = salesData.sales.map((sale) => ({
    date: sale.date,
    invoiceNumber: sale.invoiceNumber,
    totalAmount: sale.totalAmount,
    paymentMethod: sale.paymentMethod ?? "Unknown",
  }));

  const prompt = `
You are DukaanSaathi AiGen's business-insights assistant.
TASK: Create exactly 3 short business-summary bullets in simple Hindi.
INPUT:
${JSON.stringify({
  periodStart: salesData.periodStart,
  periodEnd: salesData.periodEnd,
  sales: sanitizedSales,
})}
RULES:
1. Return ONLY valid JSON schema: { "bullets": ["string", "string", "string"] }
2. Use simple Hindi suitable for a small Indian shopkeeper.
3. Summarize observed sales patterns only. Do not invent numbers.
4. Never calculate, modify or instruct changes to financial or inventory records.
5. Exactly three bullets.
`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      temperature: 0.2,
      responseMimeType: "application/json",
    },
  });

  const text = response.text?.trim();
  if (!text) throw new Error("Gemini returned an empty response");

  const parsed = extractJson(text) as Partial<DailySummaryResult>;

  if (
    !Array.isArray(parsed.bullets) ||
    parsed.bullets.length !== 3 ||
    !parsed.bullets.every((item) => typeof item === "string")
  ) {
    throw new Error("Gemini returned an invalid daily-summary schema");
  }

  if (containsForbiddenMutation(parsed.bullets)) {
    throw new Error("Unsafe financial mutation content detected in AI output");
  }

  return {
    bullets: [parsed.bullets[0], parsed.bullets[1], parsed.bullets[2]],
  };
}

export async function detectDeadStock(inventoryData: InventoryData): Promise<DeadStockResult> {
  const zeroSalesItems = inventoryData.inventory.filter(
    (item) => Number.isFinite(item.salesLast30Days) && item.salesLast30Days === 0
  );

  const promptInventory = zeroSalesItems.map((item) => ({
    productId: item.productId,
    name: item.name,
    sku: item.sku,
    currentStock: item.currentStock,
    salesLast30Days: item.salesLast30Days,
  }));

  const prompt = `
You are DukaanSaathi AiGen's inventory assistant.
TASK: Explain the dead-stock items supplied below. An item qualifies as dead stock ONLY because the server verified its salesLast30Days is 0.
INPUT:
${JSON.stringify({ items: promptInventory })}
RULES:
1. Return ONLY valid JSON schema: { "items": [{"productId":"string","name":"string","sku":"string","currentStock":number,"salesLast30Days":0}], "summary": "string" }
2. Do not invent products or modify numbers.
3. The summary must be simple Hindi. No SQL or executable commands.
`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      temperature: 0.1,
      responseMimeType: "application/json",
    },
  });

  const text = response.text?.trim();
  if (!text) throw new Error("Gemini returned an empty response");

  const parsed = extractJson(text) as Partial<DeadStockResult>;

  if (!Array.isArray(parsed.items) || typeof parsed.summary !== "string") {
    throw new Error("Gemini returned an invalid dead-stock schema");
  }

  const sourceById = new Map(zeroSalesItems.map((item) => [item.productId, item]));

  const validatedItems = parsed.items
    .filter((item) => typeof item.productId === "string" && sourceById.has(item.productId))
    .map((item) => {
      const source = sourceById.get(item.productId)!;
      return {
        productId: source.productId,
        name: source.name,
        sku: source.sku,
        currentStock: source.currentStock,
        salesLast30Days: 0,
      };
    });

  if (containsForbiddenMutation(parsed.summary)) {
    throw new Error("Unsafe financial mutation content detected in AI output");
  }

  return {
    items: validatedItems,
    summary: parsed.summary,
  };
}
