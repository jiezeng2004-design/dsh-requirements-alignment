"use strict";

/* ---------- tiny helpers ---------- */

const $ = (id) => document.getElementById(id);

function fmtMoney(value, currency) {
  const symbols = { USD: "$", EUR: "€", GBP: "£", CAD: "C$", AUD: "A$", INR: "₹", BRL: "R$", JPY: "¥" };
  const sym = symbols[currency] || "";
  const n = Number(value);
  if (n >= 1000) return sym + Math.round(n).toLocaleString("en-US");
  return sym + Math.round(n).toLocaleString("en-US");
}

function fmtRange(low, high, currency) {
  return `${fmtMoney(low, currency)}–${fmtMoney(high, currency)}`;
}

/* ---------- step navigation ---------- */

function showStep(n) {
  for (let i = 1; i <= 3; i++) $(`step${i}`).hidden = i !== n;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

$("toStep2").addEventListener("click", () => {
  const text = $("serviceInput").value.trim();
  if (text.length < 10) {
    $("errorMsg").textContent = "Tell us a bit more about your service (at least a sentence).";
    $("errorMsg").hidden = false;
    $("serviceInput").focus();
    return;
  }
  $("errorMsg").hidden = true;
  showStep(2);
});

$("backToStep1").addEventListener("click", () => showStep(1));
$("restartBtn").addEventListener("click", () => {
  $("serviceInput").value = "";
  $("detailsInput").value = "";
  $("extraInput").value = "";
  $("experienceSelect").value = "";
  $("clientSelect").value = "";
  $("deliverableSelect").value = "";
  $("locationInput").value = "";
  $("errorMsg").hidden = true;
  showStep(1);
});

/* ---------- report rendering ---------- */

function renderReport(report) {
  const cur = report.currency || "USD";
  const syms = { USD: "$", EUR: "€", GBP: "£", CAD: "C$", AUD: "A$", INR: "₹", BRL: "R$", JPY: "¥" };
  const sym = syms[cur] || "";

  $("summaryBox").textContent = report.summary || "";
  $("hourlyRange").textContent = fmtRange(report.hourly.low, report.hourly.high, cur);
  $("hourlyMid").textContent = sym + Math.round(report.hourly.mid);
  $("hourlyHigh").textContent = sym + Math.round(report.hourly.high);
  $("projectRange").textContent = fmtRange(report.project.low, report.project.high, cur);
  $("projectMid").textContent = sym + Math.round(report.project.mid);

  // tiers
  const tiersBox = $("tiersBox");
  tiersBox.innerHTML = "";
  (report.tiers || []).forEach((t, i) => {
    const el = document.createElement("div");
    el.className = "tier" + (i === 1 ? " featured" : "");
    const tag = i === 1 ? '<span class="tier-tag">Recommended</span>' : "";
    el.innerHTML = `
      <div><span class="tier-name"></span>${tag}</div>
      <div class="tier-price"></div>
      <div class="tier-desc"></div>`;
    el.querySelector(".tier-name").textContent = t.name;
    el.querySelector(".tier-price").textContent = fmtMoney(t.price, cur);
    el.querySelector(".tier-desc").textContent = t.description || "";
    tiersBox.appendChild(el);
  });

  fillList("rationaleBox", report.rationale);
  fillList("tipsBox", report.tips);

  const sharp = report.sharpening || [];
  $("sharpenPanel").hidden = sharp.length === 0;
  fillList("sharpeningBox", sharp);

  $("blurbBox").textContent = report.blurb || "";
  const conf = Math.round((report.confidence || 0.5) * 100);
  $("confidenceBox").textContent =
    `Estimate confidence: ${conf}% — based on the detail you provided.`;

  const fb = $("fallbackNote");
  if (report.mode === "builtin") {
    fb.hidden = false;
    fb.textContent = report.fallback_reason
      ? `⚙ Built-in estimator used: ${report.fallback_reason}`
      : "⚙ Running on the built-in estimator (no AI provider configured). Set OPENAI_API_KEY for richer, tailored reports.";
  } else {
    fb.hidden = true;
  }

  showStep(3);
}

function fillList(id, items) {
  const box = $(id);
  box.innerHTML = "";
  (items || []).forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    box.appendChild(li);
  });
}

/* ---------- generate ---------- */

async function generate() {
  const btn = $("generateBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Pricing your work…';
  $("errorMsg").hidden = true;

  const payload = {
    service: $("serviceInput").value.trim(),
    details: $("detailsInput").value.trim(),
    experience: $("experienceSelect").value,
    client_type: $("clientSelect").value,
    deliverable: $("deliverableSelect").value,
    location: $("locationInput").value.trim(),
    currency: $("currencySelect").value,
    extra: $("extraInput").value.trim(),
  };

  try {
    const res = await fetch("/api/estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || "Something went wrong while estimating.");
    }
    renderReport(data.report);
  } catch (err) {
    $("errorMsg").textContent = err.message;
    $("errorMsg").hidden = false;
  } finally {
    btn.disabled = false;
    btn.innerHTML = "Generate my pricing report <span class=\"arrow\">→</span>";
  }
}

$("generateBtn").addEventListener("click", generate);
$("serviceInput").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") $("toStep2").click();
});

/* ---------- copy summary ---------- */

$("copyBtn").addEventListener("click", async () => {
  const text = $("summaryBox").textContent;
  const btn = $("copyBtn");
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied ✓";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = "Copy summary"), 1600);
});

/* ---------- mode badge ---------- */

(async () => {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    const badge = $("modeBadge");
    if (data.mode === "llm") {
      badge.classList.add("ai");
      $("modeText").textContent = `AI-powered · ${data.model || "LLM"}`;
    } else {
      badge.classList.add("builtin");
      $("modeText").textContent = "Built-in estimator";
    }
  } catch {
    $("modeText").textContent = "offline";
  }
})();
