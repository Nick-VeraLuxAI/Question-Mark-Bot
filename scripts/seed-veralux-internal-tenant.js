#!/usr/bin/env node
/**
 * Idempotent: create/update the `veralux` tenant for VeraLux company dogfood (Solomon).
 * Does not print or store secrets. Safe to re-run; merges settings / branding without wiping
 * unrelated keys.
 *
 * Usage (from repo root, with DATABASE_URL in .env or env):
 *   node scripts/seed-veralux-internal-tenant.js
 *
 * Chat readiness: relies on global OPENAI_API_KEY or per-tenant openaiKey (not set here).
 * Set OPENAI_API_KEY in deployment env or add tenant key via admin / KMS.
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { PrismaClient } = require("@prisma/client");

const SLUG = "veralux";
const DISPLAY_NAME = "VeraLux AI";

function mergeDeep(a, b) {
  if (b == null) return a;
  if (a == null || typeof a !== "object" || Array.isArray(a)) return b;
  if (typeof b !== "object" || Array.isArray(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = mergeDeep(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const SETTINGS_PATCH = {
  businessProfile: {
    businessName: "VeraLux AI",
    shortDescription:
      "VeraLux AI builds premium AI assistants for websites and phone lines. This chat is our live company assistant for https://veralux.ai — answer questions, qualify interest, and capture leads.",
    services: "",
    serviceAreas: "",
    address: "",
    phone: "",
    email: "veralux.team@gmail.com",
    website: "https://veralux.ai",
    bookingUrl: "",
    hours: "Business hours: configure in admin if needed.",
    afterHoursMessage: "",
    escalationContact: "",
    policies: "",
    updatedAt: new Date().toISOString(),
  },
  behavior: {
    greeting:
      "Welcome to VeraLux AI. I can explain our services, answer questions, and connect you with our team.",
    tone: "luxury",
    businessRole:
      "You are VeraLux AI’s website assistant: explain VeraLux AI services, answer product questions, qualify leads, collect contact details, and route serious inquiries to the team.",
    primaryGoal:
      "Help visitors understand VeraLux AI offerings and capture structured leads (name, email, phone, company, business need, timeline).",
    fallbackAnswer:
      "I don’t have that detail handy. I can take a message with your contact information so our team can follow up.",
    escalationInstructions:
      "For urgent or high-value opportunities, offer to connect the visitor with the VeraLux team and capture full contact details.",
    leadCaptureInstructions:
      "When a visitor shows buying intent or requests contact, collect: full name, email, phone, company, business need, and timeline. Confirm spelling for email if possible.",
    avoidTopics: "",
    specialRules:
      "Tone: premium, clear, practical, professional. Brand feel: black, charcoal, gold. Do not invent pricing guarantees; offer to connect for formal quotes.",
    updatedAt: new Date().toISOString(),
  },
  appearance: {
    theme: "dark",
    embed: {
      welcomeTitle: "VeraLux AI",
      welcomeSubtitle: "Ask about our assistants for web and phone — or leave your details for the team.",
    },
  },
};

async function main() {
  const prisma = new PrismaClient();
  try {
    const existing = await prisma.tenant.findUnique({
      where: { id: SLUG },
      select: { settings: true },
    });
    const mergedSettings = mergeDeep(
      existing?.settings && typeof existing.settings === "object" ? existing.settings : {},
      SETTINGS_PATCH,
    );

    await prisma.tenant.upsert({
      where: { id: SLUG },
      create: {
        id: SLUG,
        name: DISPLAY_NAME,
        subdomain: SLUG,
        plan: "basic",
        settings: mergedSettings,
        prompts: {},
        branding: {},
        brandColor: "#C9A227",
        brandHover: "#A68520",
        botBg: "#0F0F0F",
        botText: "#F5F5F5",
        userBg: "#1A1A1A",
        userText: "#E8E8E8",
      },
      update: {
        name: DISPLAY_NAME,
        subdomain: SLUG,
        settings: mergedSettings,
        brandColor: "#C9A227",
        brandHover: "#A68520",
        botBg: "#0F0F0F",
        botText: "#F5F5F5",
        userBg: "#1A1A1A",
        userText: "#E8E8E8",
      },
    });

    console.log(`[seed-veralux] Upserted tenant id=${SLUG} subdomain=${SLUG} name=${DISPLAY_NAME}`);
    console.log(
      "[seed-veralux] Public chat: ?tenant=veralux or host slug veralux (not reserved).",
    );
    console.log(
      "[seed-veralux] Verify: npm run tenant:verify -- --slug veralux   (needs DB + env)",
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
