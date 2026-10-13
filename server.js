
 // Live Crash — authenticated server
// Node.js 18+ recommended.
// Required env: PAYSTACK_SECRET_KEY
// Optional env: ADMIN_KEY, PORT, PUBLIC_URL

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const DATA_FILE = path.join(__dirname, "data.json");

const START_BALANCE = 1000;
const BONUS_BALANCE = 500;
const MIN_BET = 10;
const MAX_BET = 10000;
const MIN_DEPOSIT = 100;
const MIN_WITHDRAW = 100;
const ROUND_BETTING_MS = 8000;
const CRASH_GROWTH = 0.00006;

let db = {
  users: {},
  emailToId: {},
  transactions: [],
  rounds: [],
  currentRound: null
};

try {
  if (fs.existsSync(DATA_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    db = { ...db, ...parsed };
  }
} catch (e) {
  console.error("Could not read data.json:", e.message);
}

let saveTimer = null;

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const temp = DATA_FILE + ".tmp";
    try {
      fs.writeFileSync(temp, JSON.stringify(db, null, 2));
      fs.renameSync(temp, DATA_FILE);
    } catch (e) {
      console.error("Save failed:", e.message);
    }
  }, 100);
}

function id(bytes = 24) {
  return crypto.randomBytes(bytes).toString("hex");
}

function now() {
  return Date.now();
}

function emailNorm(v) {
  return String(v || "").trim().toLowerCase();
}

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    balance: u.balance,
    bonus: u.bonus,
    createdAt: u.createdAt
  };
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function text(
  res,
  status,
  body,
  type = "text/plain; charset=utf-8"
) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", chunk => {
      raw += chunk;

      if (raw.length > 1000000) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!raw) return resolve({});

      const ct = String(
        req.headers["content-type"] || ""
      );

      try {
        if (ct.includes("application/x-www-form-urlencoded")) {
          const params = new URLSearchParams(raw);
          const obj = {};

          for (const [k, v] of params) {
            obj[k] = v;
          }

          return resolve(obj);
        }

        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid request body"));
      }
    });

    req.on("error", reject);
  });
}

function tokenFrom(req, url, body) {
  const header = String(req.headers.authorization || "");
  const bearer = header.match(/^Bearer\s+(.+)$/i);

  return (
    (bearer && bearer[1]) ||
    url.searchParams.get("token") ||
    (body && body.token) ||
    ""
  );
}

function authUser(token) {
  if (!token || typeof token !== "string") return null;

  for (const u of Object.values(db.users)) {
    if (u.token === token) return u;
  }

  return null;
}

function requireUser(req, url, body) {
  const u = authUser(tokenFrom(req, url, body));

  if (!u) {
    throw Object.assign(
      new Error("Please log in again."),
      { status: 401 }
    );
  }

  return u;
}

function addTx(tx) {
  db.transactions.unshift({
    id: id(8),
    createdAt: now(),
    ...tx
  });

  db.transactions = db.transactions.slice(0, 3000);
  save();
}

function safeAmount(v) {
  const n = Number(v);

  return Number.isFinite(n) &&
    n > 0 &&
    n <= 100000000
      ? Math.round(n * 100) / 100
      : 0;
}

function passwordHash(password, salt) {
  return crypto
    .scryptSync(password, salt, 64)
    .toString("hex");
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));

  return aa.length === bb.length &&
    crypto.timingSafeEqual(aa, bb);
}

function makeUser({ name, email, password }) {
  const normalized = emailNorm(email);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw Object.assign(
      new Error("Enter a valid email address."),
      { status: 400 }
    );
  }

  if (String(password || "").length < 8) {
    throw Object.assign(
      new Error("Password must be at least 8 characters."),
      { status: 400 }
    );
  }

  if (db.emailToId[normalized]) {
    throw Object.assign(
      new Error(
        "An account with this email already exists. Log in instead."
      ),
      { status: 409 }
    );
  }

  const userId = id(16);
  const salt = id(16);

  const u = {
    id: userId,
    name: String(name || "").trim().slice(0, 60) ||
      normalized.split("@")[0],
    email: normalized,
    salt,
    passwordHash: passwordHash(String(password), salt),
    token: id(32),
    balance: START_BALANCE,
    bonus: BONUS_BALANCE,
    createdAt: now(),
    bets: [],
    history: [],
    bank: null,
    pendingWithdrawals: []
  };

  db.users[userId] = u;
  db.emailToId[normalized] = userId;
  save();

  return u;
}

function newRound() {
  const round = {
    id: id(6),
    status: "betting",
    startAt: now(),
    crashAt: null,
    crashPoint: null,
    bets: {}
  };

  db.currentRound = round;
  save();

  broadcast({
    type: "round",
    round: roundPublic(round)
  });

  setTimeout(() => startRound(round.id), ROUND_BETTING_MS);
}

function roundPublic(r) {
  if (!r) return null;

  return {
    id: r.id,
    status: r.status,
    startAt: r.startAt,
    crashAt: r.crashAt,
    crashPoint: r.status === "crashed"
      ? r.crashPoint
      : null,
    bets: Object.values(r.bets || {}).map(b => ({
      userId: b.userId,
      amount: b.amount,
      cashedOut: b.cashedOut,
      multiplier: b.multiplier
    }))
  };
}

function randomCrashPoint() {
  const r = Math.random();

  return Math.max(
    1,
    Math.floor((0.99 / Math.max(0.0001, 1 - r)) * 100) / 100
  );
}

function startRound(roundId) {
  const r = db.currentRound;

  if (!r || r.id !== roundId || r.status !== "betting") {
    return;
  }

  r.status = "running";
  r.startAt = now();
  r.crashPoint = randomCrashPoint();
  r.crashAt =
    r.startAt + Math.log(r.crashPoint) / CRASH_GROWTH;

  save();

  broadcast({
    type: "round",
    round: roundPublic(r)
  });

  const timer = setInterval(() => {
    const current = db.currentRound;

    if (
      !current ||
      current.id !== roundId ||
      current.status !== "running"
    ) {
      clearInterval(timer);
      return;
    }

    if (now() >= current.crashAt) {
      clearInterval(timer);
      crashRound(roundId);
    } else {
      broadcast({
        type: "tick",
        roundId,
        multiplier: currentMultiplier(current)
      });
    }
  }, 250);
}

function currentMultiplier(r) {
  if (!r || r.status === "betting") return 1;
  if (r.status === "crashed") return r.crashPoint;

  return Math.max(
    1,
    Math.floor(
      Math.exp((now() - r.startAt) * CRASH_GROWTH) * 100
    ) / 100
  );
}

function crashRound(roundId) {
  const r = db.currentRound;

  if (!r || r.id !== roundId || r.status !== "running") {
    return;
  }

  r.status = "crashed";

  for (const b of Object.values(r.bets || {})) {
    if (!b.cashedOut) {
      const u = db.users[b.userId];

      if (u) {
        u.history.unshift({
          at: now(),
          roundId,
          amount: b.amount,
          result: "LOSS",
          payout: 0,
          multiplier: r.crashPoint
        });

        u.history = u.history.slice(0, 200);
      }
    }
  }

  db.rounds.unshift({
    id: r.id,
    crashPoint: r.crashPoint,
    at: now()
  });

  db.rounds = db.rounds.slice(0, 100);
  save();

  broadcast({
    type: "round",
    round: roundPublic(r)
  });

  setTimeout(() => newRound(), 3500);
}

const clients = new Set();

function broadcast(obj) {
  const packet = `data: ${JSON.stringify(obj)}\n\n`;

  for (const c of [...clients]) {
    try {
      c.res.write(packet);
    } catch {
      clients.delete(c);
    }
  }
}

function sse(req, res, u) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  res.write(
    `data: ${JSON.stringify({
      type: "init",
      user: publicUser(u),
      round: roundPublic(db.currentRound),
      history: db.rounds.slice(0, 20)
    })}\n\n`
  );

  const client = {
    res,
    userId: u.id
  };

  clients.add(client);

  req.on("close", () => clients.delete(client));
}

function requireAdmin(req, url) {
  const key =
    url.searchParams.get("key") ||
    req.headers["x-admin-key"];

  if (!ADMIN_KEY || !safeEqual(key, ADMIN_KEY)) {
    throw Object.assign(
      new Error("Admin access denied"),
      { status: 403 }
    );
  }
}

async function paystack(pathname, payload) {
  if (!PAYSTACK_SECRET_KEY) {
    throw Object.assign(
      new Error("Paystack is not configured yet."),
      { status: 503 }
    );
  }

  const response = await fetch(
    "https://api.paystack.co" + pathname,
    {
      method: payload ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json"
      },
      body: payload ? JSON.stringify(payload) : undefined
    }
  );

  const data = await response.json();

  if (!response.ok || !data.status) {
    throw Object.assign(
      new Error(data.message || "Paystack request failed"),
      { status: 400 }
    );
  }

  return data.data;
}

function creditVerifiedDeposit(reference, paystackData) {
  const tx = db.transactions.find(
    t => t.reference === reference && t.type === "deposit"
  );

  if (!tx || tx.status === "completed") return false;

  const u = db.users[tx.userId];
  const amountNaira = Number(paystackData.amount) / 100;

  if (
    !u ||
    paystackData.status !== "success" ||
    paystackData.currency !== "NGN" ||
    Math.round(amountNaira * 100) !==
      Math.round(Number(tx.amount) * 100) ||
    (
      paystackData.metadata &&
      paystackData.metadata.userId &&
      paystackData.metadata.userId !== u.id
    )
  ) {
    tx.status = "verification_failed";
    tx.updatedAt = now();
    save();
    return false;
  }

  // Credit once, then mark the transaction completed.
  u.balance =
    Math.round((Number(u.balance) + amountNaira) * 100) / 100;

  tx.status = "completed";
  tx.updatedAt = now();
  tx.creditedAt = now();

  save();
  return true;
}

async function route(req, res) {
  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  const pathname = url.pathname;
  let body = {};

  if (["POST", "PUT", "PATCH"].includes(req.method)) {
    body = await readBody(req);
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-Admin-Key",
      "Access-Control-Allow-Methods":
        "GET, POST, OPTIONS"
    });
    return res.end();
  }

  if (pathname === "/health") {
    return json(res, 200, {
      ok: true,
      name: "Live Crash",
      time: now()
    });
  }

  // Registration
  if (pathname === "/auth/register" && req.method === "POST") {
    const u = makeUser(body);

    return json(res, 201, {
      ok: true,
      token: u.token,
      user: publicUser(u)
    });
  }

  // Login
  if (pathname === "/auth/login" && req.method === "POST") {
    const email = emailNorm(body.email);
    const uid = db.emailToId[email];
    const u = uid && db.users[uid];

    if (
      !u ||
      !safeEqual(
        passwordHash(String(body.password || ""), u.salt),
        u.passwordHash
      )
    ) {
      return json(res, 401, {
        ok: false,
        error: "Email or password is incorrect."
      });
    }

    // Issue a fresh login token.
    u.token = id(32);
    save();

    return json(res, 200, {
      ok: true,
      token: u.token,
      user: publicUser(u)
    });
  }

  // Logout
  if (pathname === "/auth/logout" && req.method === "POST") {
    const u = requireUser(req, url, body);
    u.token = id(32);
    save();

    return json(res, 200, { ok: true });
  }

  // Paystack webhook: verify its signature before crediting.
  if (pathname === "/paystack/webhook" && req.method === "POST") {
    const signature = req.headers["x-paystack-signature"];

    const expected = crypto
      .createHmac("sha512", PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(body))
      .digest("hex");

    if (
      !PAYSTACK_SECRET_KEY ||
      !signature ||
      !safeEqual(signature, expected)
    ) {
      return json(res, 401, { ok: false });
    }

    if (
      body.event === "charge.success" &&
      body.data &&
      body.data.reference
    ) {
      creditVerifiedDeposit(body.data.reference, body.data);
    }

    return json(res, 200, { received: true });
  }

  // Verify Paystack payment after the checkout redirect.
  if (pathname === "/paystack/callback" && req.method === "GET") {
    const reference =
      url.searchParams.get("reference") ||
      url.searchParams.get("trxref");

    if (!reference) {
      return text(res, 400, "Missing payment reference");
    }

    try {
      const data = await paystack(
        "/transaction/verify/" + encodeURIComponent(reference)
      );

      creditVerifiedDeposit(reference, data);

      return text(
        res,
        200,
        "Payment verification finished. You can return to the game."
      );
    } catch (e) {
      return text(res, e.status || 400, e.message);
    }
  }

  // Authenticated live game stream.
  if (pathname === "/events" && req.method === "GET") {
    let u;

    try {
      u = requireUser(req, url, body);
    } catch (e) {
      return json(res, e.status || 401, {
        ok: false,
        error: e.message
      });
    }

    return sse(req, res, u);
  }

  // The remaining routes continue in Part 5.

  // Admin routes
  if (pathname.startsWith("/admin")) {
    requireAdmin(req, url);

    if (pathname === "/admin") {
      return text(
        res,
        200,
        "<!doctype html><html><body style='background:#100b22;color:white;font-family:Arial;padding:20px'><h2>Live Crash Admin</h2><p>Admin API: /admin/api/summary?key=YOUR_ADMIN_KEY</p></body></html>",
        "text/html; charset=utf-8"
      );
    }

    if (pathname === "/admin/api/summary" && req.method === "GET") {
      return json(res, 200, {
        users: Object.values(db.users).map(u => ({
          ...publicUser(u),
          bank: u.bank,
          pendingWithdrawals: u.pendingWithdrawals
        })),
        transactions: db.transactions.slice(0, 200),
        rounds: db.rounds
      });
    }

    if (pathname === "/admin/api/withdrawals" && req.method === "GET") {
      return json(res, 200, {
        withdrawals: db.transactions.filter(
          t => t.type === "withdrawal" && t.status === "pending"
        )
      });
    }

    if (
      pathname === "/admin/api/withdrawals/approve" &&
      req.method === "POST"
    ) {
      const tx = db.transactions.find(
        t => t.id === body.id &&
          t.type === "withdrawal" &&
          t.status === "pending"
      );

      if (!tx) {
        return json(res, 404, {
          ok: false,
          error: "Pending withdrawal not found."
        });
      }

      tx.status = "approved";
      tx.updatedAt = now();
      save();

      return json(res, 200, { ok: true, transaction: tx });
    }

    if (
      pathname === "/admin/api/withdrawals/reject" &&
      req.method === "POST"
    ) {
      const tx = db.transactions.find(
        t => t.id === body.id &&
          t.type === "withdrawal" &&
          t.status === "pending"
      );

      if (!tx) {
        return json(res, 404, {
          ok: false,
          error: "Pending withdrawal not found."
        });
      }

      const u = db.users[tx.userId];

      if (u && !tx.refundedAt) {
        u.balance += tx.amount;
        tx.refundedAt = now();
      }

      tx.status = "rejected";
      tx.updatedAt = now();
      save();

      return json(res, 200, { ok: true, transaction: tx });
    }

    return json(res, 404, {
      ok: false,
      error: "Unknown admin endpoint"
    });
  }

  let u;

  try {
    u = requireUser(req, url, body);
  } catch (e) {
    if (pathname.startsWith("/api/")) {
      return json(res, e.status || 401, {
        ok: false,
        error: e.message
      });
    }
  }

  if (pathname === "/api/me" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      user: publicUser(u)
    });
  }

  if (pathname === "/api/restore" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      user: publicUser(u),
      round: roundPublic(db.currentRound),
      history: db.rounds.slice(0, 20)
    });
  }

  if (pathname === "/api/history" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      history: (u.history || []).slice(0, 100),
      rounds: db.rounds.slice(0, 50)
    });
  }

  if (pathname === "/api/transactions" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      transactions: db.transactions
        .filter(t => t.userId === u.id)
        .slice(0, 100)
    });
  }

  if (pathname === "/api/bet" && req.method === "POST") {
    const amount = safeAmount(body.amount);
    const r = db.currentRound;

    if (amount < MIN_BET || amount > MAX_BET) {
      return json(res, 400, {
        ok: false,
        error: `Bet must be ₦${MIN_BET}–₦${MAX_BET}.`
      });
    }

    if (!r || r.status !== "betting") {
      return json(res, 409, {
        ok: false,
        error: "Betting is closed for this round."
      });
    }

    if (r.bets[u.id]) {
      return json(res, 409, {
        ok: false,
        error: "You already placed a bet this round."
      });
    }

    if (u.balance < amount) {
      return json(res, 400, {
        ok: false,
        error: "Insufficient balance."
      });
    }

    u.balance = Math.round((u.balance - amount) * 100) / 100;

    r.bets[u.id] = {
      userId: u.id,
      amount,
      cashedOut: false,
      multiplier: null
    };

    save();

    return json(res, 200, {
      ok: true,
      balance: u.balance,
      round: roundPublic(r)
    });
  }

  if (pathname === "/api/cashout" && req.method === "POST") {
    const r = db.currentRound;
    const b = r && r.bets[u.id];

    if (!r || r.status !== "running" || !b || b.cashedOut) {
      return json(res, 400, {
        ok: false,
        error: "No active bet to cash out."
      });
    }

    const mult = currentMultiplier(r);

    if (mult >= r.crashPoint || now() >= r.crashAt) {
      return json(res, 400, {
        ok: false,
        error: "Too late — the round crashed."
      });
    }

    const payout = Math.floor(b.amount * mult * 100) / 100;

    b.cashedOut = true;
    b.multiplier = mult;

    u.balance = Math.round((u.balance + payout) * 100) / 100;

    u.history.unshift({
      at: now(),
      roundId: r.id,
      amount: b.amount,
      result: "WIN",
      payout,
      multiplier: mult
    });

    u.history = u.history.slice(0, 200);
    save();

    return json(res, 200, {
      ok: true,
      balance: u.balance,
      payout,
      multiplier: mult
    });
  }

  if (pathname === "/api/cancel" && req.method === "POST") {
    const r = db.currentRound;
    const b = r && r.bets[u.id];

    if (!r || r.status !== "betting" || !b) {
      return json(res, 400, {
        ok: false,
        error: "No cancellable bet."
      });
    }

    u.balance += b.amount;
    delete r.bets[u.id];
    save();

    return json(res, 200, {
      ok: true,
      balance: u.balance
    });
  }

  if (pathname === "/api/bonus" && req.method === "POST") {
    return json(res, 200, {
      ok: true,
      bonus: u.bonus || 0,
      balance: u.balance
    });
  }

  if (pathname === "/api/deposit" && req.method === "POST") {
    const amount = safeAmount(body.amount);

    if (amount < MIN_DEPOSIT) {
      return json(res, 400, {
        ok: false,
        error: `Minimum deposit is ₦${MIN_DEPOSIT}.`
      });
    }

    try {
      const reference =
        "LC_" + u.id.slice(0, 8) + "_" + id(8);

      const callback_url = PUBLIC_URL
        ? PUBLIC_URL + "/paystack/callback"
        : undefined;

      const data = await paystack("/transaction/initialize", {
        email: u.email,
        amount: Math.round(amount * 100),
        currency: "NGN",
        reference,
        callback_url,
        metadata: {
          userId: u.id,
          name: u.name
        }
      });

      addTx({
        userId: u.id,
        type: "deposit",
        amount,
        reference,
        status: "pending",
        authorizationUrl: data.authorization_url
      });

      return json(res, 200, {
        ok: true,
        reference,
        authorization_url: data.authorization_url,
        url: data.authorization_url
      });
    } catch (e) {
      return json(res, e.status || 400, {
        ok: false,
        error: e.message
      });
    }
  }

  if (pathname === "/api/banks" && req.method === "GET") {
    try {
      const banks = await paystack(
        "/bank?country=nigeria&perPage=100"
      );

      return json(res, 200, { ok: true, banks });
    } catch (e) {
      return json(res, e.status || 503, {
        ok: false,
        error: e.message,
        banks: []
      });
    }
  }

  if (pathname === "/api/resolveBank" && req.method === "POST") {
    const accountNumber = String(
      body.accountNumber || body.account_number || ""
    ).trim();

    const bankCode = String(
      body.bankCode || body.bank_code || ""
    ).trim();

    if (!/^\d{10}$/.test(accountNumber) || !bankCode) {
      return json(res, 400, {
        ok: false,
        error: "Enter a valid 10-digit account number and select a bank."
      });
    }

    try {
      const data = await paystack(
        `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`
      );

      u.bank = {
        accountNumber,
        bankCode,
        accountName: data.account_name,
        verifiedAt: now()
      };

      save();

      return json(res, 200, {
        ok: true,
        accountName: data.account_name,
        bank: u.bank
      });
    } catch (e) {
      return json(res, e.status || 400, {
        ok: false,
        error: e.message
      });
    }
  }

  if (pathname === "/api/withdraw" && req.method === "POST") {
    const amount = safeAmount(body.amount);

    if (amount < MIN_WITHDRAW) {
      return json(res, 400, {
        ok: false,
        error: `Minimum withdrawal is ₦${MIN_WITHDRAW}.`
      });
    }

    if (!u.bank || !u.bank.verifiedAt) {
      return json(res, 400, {
        ok: false,
        error: "Verify your bank account first."
      });
    }

    if (u.balance < amount) {
      return json(res, 400, {
        ok: false,
        error: "Insufficient balance."
      });
    }

    u.balance = Math.round((u.balance - amount) * 100) / 100;

    addTx({
      userId: u.id,
      type: "withdrawal",
      amount,
      status: "pending",
      bank: u.bank
    });

    return json(res, 200, {
      ok: true,
      balance: u.balance,
      message: "Withdrawal request submitted for admin review."
    });
  }

  return json(res, 404, {
    ok: false,
    error: "Not found."
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");

  try {
    await route(req, res);
  } catch (e) {
    console.error("Request error:", e);

    if (!res.headersSent) {
      json(res, e.status || 500, {
        ok: false,
        error: e.message || "Server error"
      });
    } else {
      res.end();
    }
  }
});

newRound();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Live Crash listening on ${PORT}`);
});

process.on("SIGTERM", () => {
  save();
  server.close(() => process.exit(0));
});
