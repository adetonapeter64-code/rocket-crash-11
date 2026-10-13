// Live Crash server + Paystack Test Wallet
// Existing crash engine kept intact.
// Run: node server.js

const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data.json');

const GROWTH = 0.1, EDGE = 0.99, X = 2 ** 52, COUNT_MS = 6000, OVER_MS = 3500,
MIN = 10, MAX = 10000, START = 1000, BONUS = 500;

// PAYSTACK TEST WALLET SETTINGS
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const APP_URL = process.env.APP_URL || '';
const PAYSTACK_CALLBACK_URL =
process.env.PAYSTACK_CALLBACK_URL ||
(APP_URL ? APP_URL + '/paystack/callback' : '');

const MIN_DEPOSIT = Number(process.env.MIN_DEPOSIT || 100);
const MAX_DEPOSIT = Number(process.env.MAX_DEPOSIT || 1000000);
const MIN_WITHDRAWAL = Number(process.env.MIN_WITHDRAWAL || 100);
const MAX_WITHDRAWAL = Number(process.env.MAX_WITHDRAWAL || 1000000);

const REQUIRE_WITHDRAWAL_APPROVAL =
String(process.env.REQUIRE_WITHDRAWAL_APPROVAL || 'true') !== 'false';

let db = {
players: {},
history: [],
nonce: 0,
roundId: 0,
transactions: [],
withdrawals: []
};

try {
db = Object.assign(db, JSON.parse(fs.readFileSync(DATA, 'utf8')));
} catch (e) {}

if (!Array.isArray(db.transactions)) db.transactions = [];
if (!Array.isArray(db.withdrawals)) db.withdrawals = [];

for (const p of Object.values(db.players)) {
if (p.bet) {
p.bal += p.bet;
p.bet = 0;
}
}

let dirty = false;

const save = () => {
dirty = true;
};

setInterval(() => {
if (dirty) {
dirty = false;
fs.writeFile(DATA, JSON.stringify(db), () => {});
}
}, 1000);

const ADMIN_KEY =
process.env.ADMIN_KEY ||
db.adminKey ||
(db.adminKey = crypto.randomBytes(9).toString('hex'));

const BOT_TOKEN = process.env.BOT_TOKEN || '';

const sha = s =>
crypto.createHash('sha256').update(s).digest('hex');

const crashFrom = h => {
const r = parseInt(h.slice(0, 13), 16);
return Math.min(
1000,
Math.max(
1,
Math.floor(100 * EDGE * X / (X - r)) / 100
)
);
};

const r2 = n => Math.round(n * 100) / 100;

const addLog = (p, l) => {
p.log.unshift(l);
p.log.length = Math.min(p.log.length, 8);
};

// =====================================================
// TELEGRAM USER VERIFICATION
// =====================================================

function tgUser(initData) {
if (!BOT_TOKEN || !initData) return null;

try {
const q = new URLSearchParams(initData);
const hash = q.get('hash');

q.delete('hash');  

const str = [...q.entries()]  
  .map(([k, v]) => k + '=' + v)  
  .sort()  
  .join('\n');  

const secret = crypto  
  .createHmac('sha256', 'WebAppData')  
  .update(BOT_TOKEN)  
  .digest();  

if (  
  crypto  
    .createHmac('sha256', secret)  
    .update(str)  
    .digest('hex') !== hash  
) {  
  return null;  
}  

const u = JSON.parse(q.get('user') || 'null');  

return u && {  
  id: u.id,  
  username: u.username || '',  
  name: [u.first_name, u.last_name]  
    .filter(Boolean)  
    .join(' ')  
};

} catch (e) {
return null;
}
}

// =====================================================
// WALLET SYSTEM
// =====================================================

const txId = prefix =>
prefix +
'' +
Date.now().toString(36) +
'' +
crypto.randomBytes(4).toString('hex');

function addTx(p, type, amount, status, extra = {}) {

const tx = {
id: txId(type),
playerId: p.id,
amount: r2(Number(amount)),
currency: 'NGN',
type,
status,
createdAt: Date.now(),
...extra
};

db.transactions.unshift(tx);

db.transactions.length =
Math.min(db.transactions.length, 2000);

return tx;
}

function findPlayerById(id) {
return Object.values(db.players)
.find(p => p.id === id);
}

function jsonReq(req, limit = 10000) {

return new Promise((resolve, reject) => {

let d = '';  

req.on('data', x => {  

  d += x;  

  if (d.length > limit) {  
    reject(new Error('Request too large'));  

    try {  
      req.destroy();  
    } catch (e) {}  
  }  

});  

req.on('end', () => {  

  try {  
    resolve(JSON.parse(d || '{}'));  
  } catch (e) {  
    resolve({});  
  }  

});  

req.on('error', reject);

});
}

// =====================================================
// PAYSTACK REQUEST
// =====================================================

async function paystack(method, endpoint, body) {

if (!PAYSTACK_SECRET_KEY) {
throw new Error(
'PAYSTACK_SECRET_KEY is not configured'
);
}

const opts = {
method,
headers: {
Authorization:
'Bearer ' + PAYSTACK_SECRET_KEY,
'Content-Type': 'application/json'
}
};

if (body !== undefined) {
opts.body = JSON.stringify(body);
}

const r = await fetch(
'https://api.paystack.co' + endpoint,
opts
);

const text = await r.text();

let data;

try {
data = JSON.parse(text);
} catch (e) {
data = {
status: false,
message: text
};
}

if (!r.ok || data.status === false) {
throw new Error(
data.message ||
'Paystack request failed'
);
}

return data;
}

// =====================================================
// VERIFY DEPOSIT
// =====================================================

async function creditVerifiedDeposit(reference) {

const existing =
db.transactions.find(
t =>
t.reference === reference &&
t.type === 'deposit'
);

if (
existing &&
existing.status === 'completed'
) {
return existing;
}

const check = await paystack(
'GET',
'/transaction/verify/' +
encodeURIComponent(reference)
);

const d = check.data;

if (!d || d.status !== 'success') {
throw new Error(
'Payment is not successful'
);
}

if (
d.currency &&
d.currency !== 'NGN'
) {
throw new Error(
'Wrong payment currency'
);
}

const amountNaira =
Number(d.amount) / 100;

if (
!(
amountNaira >= MIN_DEPOSIT &&
amountNaira <= MAX_DEPOSIT
)
) {
throw new Error(
'Payment amount outside allowed range'
);
}

const playerId =
d.metadata &&
d.metadata.player_id;

const p =
playerId
? findPlayerById(playerId)
: null;

if (!p) {
throw new Error(
'Player for payment not found'
);
}

if (existing) {

existing.status = 'completed';  

existing.amount =  
  r2(amountNaira);  

existing.paystackId = d.id;  

existing.verifiedAt =  
  Date.now();

} else {

p.bal =  
  r2(  
    p.bal +  
    amountNaira  
  );  

addTx(  
  p,  
  'deposit',  
  amountNaira,  
  'completed',  
  {  
    reference,  
    provider: 'paystack',  
    paystackId: d.id,  
    verifiedAt: Date.now()  
  }  
);

}

p.email =
p.email ||
(d.customer &&
d.customer.email) ||
'';

save();

broadcast();

return (
existing ||
db.transactions[0]
);
}

// =====================================================
// PAYSTACK WITHDRAWAL
// =====================================================

async function createWithdrawalTransfer(w) {

const p =
findPlayerById(
w.playerId
);

if (!p) {
throw new Error(
'Player not found'
);
}

const recipient =
await paystack(
'POST',
'/transferrecipient',
{
type: 'nuban',
name: w.accountName,
account_number:
w.accountNumber,
bank_code:
w.bankCode,
currency: 'NGN'
}
);

const transfer =
await paystack(
'POST',
'/transfer',
{
source: 'balance',
amount:
Math.round(
w.amount * 100
),
recipient:
recipient.data.recipient_code,
reference:
w.reference,
reason:
'Crash Game withdrawal',
currency: 'NGN'
}
);

w.recipientCode =
recipient.data.recipient_code;

w.transferCode =
transfer.data &&
transfer.data.transfer_code;

w.paystackStatus =
transfer.data &&
transfer.data.status;

w.status =
w.paystackStatus === 'failed'
? 'failed'
: 'processing';

w.updatedAt =
Date.now();

const tx =
db.transactions.find(
t =>
t.reference ===
w.reference
);

if (tx) {
tx.status =
w.status;

tx.transferCode =  
  w.transferCode;

}

save();
broadcast();

return w;
}

// =====================================================
// CRASH ENGINE
// =====================================================

let R = null;

function startRound() {

const seed =
crypto.randomBytes(16)
.toString('hex');

db.nonce++;
db.roundId++;

R = {
id: db.roundId,
phase: 'count',
seed,
nonce: db.nonce,
commit: sha(seed),
crash:
crashFrom(
sha(
seed +
':' +
db.nonce
)
),
countEnd:
Date.now() + COUNT_MS,
flyStart: 0,
overEnd: 0,
bets: {}
};

save();
broadcast();
}

function cash(t, m) {

const b =
R.bets[t];

const p =
db.players[t];

if (!b || b.at || !p)
return;

b.at = m;

const win =
r2(
b.amt * m
);

p.bal =
r2(
p.bal + win
);

p.pnl =
r2(
p.pnl +
win -
b.amt
);

p.bet = 0;

p.st.r++;
p.st.w++;

p.st.best =
Math.max(
p.st.best,
m
);

p.st.big =
Math.max(
p.st.big,
r2(
win -
b.amt
)
);

addLog(
p,
{
crash: null,
amt: b.amt,
at: m,
profit:
r2(
win -
b.amt
)
}
);

addTx(
p,
'win',
win,
'completed',
{
multiplier: m,
roundId: R.id
}
);

save();
broadcast();
}

function endRound() {

R.phase = 'over';

R.overEnd =
Date.now() +
OVER_MS;

for (
const [t, b]
of Object.entries(R.bets)
) {

const p =  
  db.players[t];  

if (!p || b.at)  
  continue;  

p.bet = 0;  

p.st.r++;  

p.pnl =  
  r2(  
    p.pnl -  
    b.amt  
  );  

addLog(  
  p,  
  {  
    crash: R.crash,  
    amt: b.amt,  
    at: 0,  
    profit:  
      -b.amt  
  }  
);  

addTx(  
  p,  
  'loss',  
  b.amt,  
  'completed',  
  {  
    roundId: R.id,  
    crash: R.crash  
  }  
);

}

db.history.unshift({
id: R.id,
crash: R.crash,
seed: R.seed,
nonce: R.nonce,
commit: R.commit
});

db.history.length =
Math.min(
db.history.length,
30
);

save();
broadcast();
}

setInterval(() => {

const now =
Date.now();

if (
R.phase === 'count' &&
now >= R.countEnd
) {

R.phase = 'fly';  

R.flyStart =  
  R.countEnd;  

broadcast();

}

if (
R.phase === 'fly'
) {

const m =  
  Math.exp(  
    GROWTH *  
    (now -  
      R.flyStart) /  
    1000  
  );  

for (  
  const [t, b]  
  of Object.entries(  
    R.bets  
  )  
) {  

  if (  
    !b.at &&  
    b.auto &&  
    b.auto < R.crash &&  
    m >= b.auto  
  ) {  
    cash(t, b.auto);  
  }  
}  

if (  
  m >= R.crash  
) {  
  endRound();  
}

} else if (
R.phase === 'over' &&
now >= R.overEnd
) {

startRound();

}

}, 50);

// =====================================================
// SERVER SNAPSHOT
// =====================================================

const conns =
new Set();

function snap(token) {

const p =
db.players[token];

const b =
R.bets[token];

const over =
R.phase === 'over';

return {

now: Date.now(),  

round: {  
  id: R.id,  
  phase: R.phase,  
  commit: R.commit,  
  countEnd: R.countEnd,  
  flyStart: R.flyStart,  
  crash:  
    over  
      ? R.crash  
      : null,  
  seed:  
    over  
      ? R.seed  
      : null  
},  

history:  
  db.history  
    .slice(0, 15)  
    .map(  
      h => h.crash  
    ),  

me:  
  p && {  
    name: p.name,  
    bal: p.bal,  
    pnl: p.pnl,  
    st: p.st,  
    log: p.log,  
    bonus: !!p.bonus,  
    bet:  
      b  
        ? {  
            amt: b.amt,  
            auto: b.auto,  
            at: b.at  
          }  
        : null  
  }

};
}

const send =
c =>
c.res.write(
'data:' +
JSON.stringify(
snap(c.token)
) +
'\n\n'
);

function broadcast() {

for (
const c
of conns
) {
send(c);
}

}

setInterval(() => {

for (
const c
of conns
) {
c.res.write(
':\n\n'
);
}

}, 15000);

setInterval(
broadcast,
10000
);

// =====================================================
// PLAYER
// =====================================================

const okToken =
t =>
typeof t === 'string' &&
/^[a-f0-9]{16,64}$/.test(t);

function player(
token,
name,
tg
) {

if (!okToken(token))
return null;

let p =
db.players[token];

if (!p) {

if (  
  Object.keys(  
    db.players  
  ).length > 5000  
) {  
  return null;  
}  

p =  
  db.players[token] =  
  {  
    name: 'Player',  
    bal: START,  
    pnl: 0,  

    st: {  
      r: 0,  
      w: 0,  
      best: 0,  
      big: 0  
    },  

    log: [],  
    bet: 0,  
    bonus: false,  
    first: Date.now(),  
    tg: null,  
    email: ''  
  };

}

if (!p.id)
p.id =
sha(token)
.slice(0, 8);

if (!p.first)
p.first =
Date.now();

if (!p.email)
p.email = '';

p.seen =
Date.now();

if (tg)
p.tg = tg;

if (name)
p.name =
String(name)
.replace(
/[<>&"']/g,
''
)
.trim()
.slice(
0,
20
) ||
'Player';

save();

return p;
}

const now = () =>
Math.exp(
GROWTH *
(Date.now() -
R.flyStart) /
1000
);

// =====================================================
// GAME + WALLET API
// =====================================================

const api = {

bet(
p,
t,
b
) {

const amt =  
  Math.floor(  
    Number(  
      b.amt  
    )  
  );  

const auto =  
  Number(  
    b.auto  
  ) >= 1.01  
    ? r2(  
        Number(  
          b.auto  
        )  
      )  
    : 0;  

if (  
  R.phase !==  
  'count'  
)  
  return 'Betting is closed for this round';  

if (  
  R.bets[t]  
)  
  return 'You already have a bet in this round';  

if (  
  !(  
    amt >= MIN &&  
    amt <= MAX  
  )  
)  
  return (  
    'Bet must be between ' +  
    MIN +  
    ' and ' +  
    MAX  
  );  

if (  
  amt > p.bal  
)  
  return 'Not enough balance';  

p.bal =  
  r2(  
    p.bal -  
    amt  
  );  

p.bet = amt;  

R.bets[t] = {  
  amt,  
  auto,  
  at: 0  
};  

addTx(  
  p,  
  'bet',  
  amt,  
  'completed',  
  {  
    roundId: R.id  
  }  
);

},

cancel(
p,
t
) {

const b =  
  R.bets[t];  

if (  
  R.phase !==  
  'count' ||  
  !b  
)  
  return 'Nothing to cancel';  

p.bal =  
  r2(  
    p.bal +  
    b.amt  
  );  

p.bet = 0;  

delete R.bets[t];  

addTx(  
  p,  
  'refund',  
  b.amt,  
  'completed',  
  {  
    roundId: R.id,  
    reason:  
      'bet_cancelled'  
  }  
);

},

cashout(
p,
t
) {

const b =  
  R.bets[t];  

if (  
  R.phase !==  
  'fly' ||  
  !b ||  
  b.at  
)  
  return 'Nothing to cash out';  

const m =  
  Math.floor(  
    now() * 100  
  ) / 100;  

if (  
  m >= R.crash  
)  
  return 'Too late, it crashed';  

cash(  
  t,  
  m  
);

},

restore(
p,
t
) {

if (  
  p.bal >= MIN ||  
  R.bets[t]  
)  
  return 'You still have coins';  

p.bal = START;  

addTx(  
  p,  
  'test_credit',  
  START,  
  'completed',  
  {  
    reason:  
      'legacy_restore'  
  }  
);

},

bonus(p) {

if (p.bonus)  
  return 'Already claimed';  

p.bonus = true;  

p.bal =  
  r2(  
    p.bal +  
    BONUS  
  );  

addTx(  
  p,  
  'bonus',  
  BONUS,  
  'completed'  
);

},

// ===================================================
// DEPOSIT
// ===================================================

async deposit(
p,
t,
b
) {

if (  
  !PAYSTACK_SECRET_KEY  
)  
  return 'Paystack is not configured yet';  

const amount =  
  Math.floor(  
    Number(  
      b.amount  
    )  
  );  

const email =  
  String(  
    b.email ||  
    p.email ||  
    ''  
  )  
    .trim()  
    .toLowerCase();  

if (  
  !(  
    amount >=  
      MIN_DEPOSIT &&  
    amount <=  
      MAX_DEPOSIT  
  )  
) {  
  return (  
    'Deposit must be between ₦' +  
    MIN_DEPOSIT +  
    ' and ₦' +  
    MAX_DEPOSIT  
  );  
}  

if (  
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(  
    email  
  )  
) {  
  return 'Enter a valid email address';  
}  

p.email =  
  email;  

const reference =  
  'crash_' +  
  Date.now().toString(36) +  
  '_' +  
  crypto  
    .randomBytes(5)  
    .toString('hex');  

addTx(  
  p,  
  'deposit',  
  amount,  
  'pending',  
  {  
    reference,  
    provider:  
      'paystack',  
    email  
  }  
);  

const out =  
  await paystack(  
    'POST',  
    '/transaction/initialize',  
    {  
      email,  
      amount:  
        String(  
          Math.round(  
            amount * 100  
          )  
        ),  
      currency:  
        'NGN',  
      reference,  
      callback_url:  
        PAYSTACK_CALLBACK_URL ||  
        undefined,  

      metadata:  
        JSON.stringify({  
          player_id:  
            p.id,  
          token_hash:  
            sha(t)  
              .slice(  
                0,  
                16  
              )  
        })  
    }  
  );  

save();  

return {  
  authorization_url:  
    out.data  
      .authorization_url,  

  reference  
};

},

// ===================================================
// BANK ACCOUNT RESOLUTION
// ===================================================

async resolveBank(
p,
t,
b
) {

const accountNumber =  
  String(  
    b.accountNumber ||  
    ''  
  ).replace(  
    /\D/g,  
    ''  
  );  

const bankCode =  
  String(  
    b.bankCode ||  
    ''  
  ).trim();  

if (  
  !/^\d{10}$/.test(  
    accountNumber  
  )  
)  
  return 'Enter a valid 10-digit account number';  

if (!bankCode)  
  return 'Select a bank';  

const out =  
  await paystack(  
    'GET',  
    '/bank/resolve?account_number=' +  
      encodeURIComponent(  
        accountNumber  
      ) +  
      '&bank_code=' +  
      encodeURIComponent(  
        bankCode  
      )  
  );  

return {  

  account_number:  
    out.data  
      .account_number,  

  account_name:  
    out.data  
      .account_name,  

  bank_code:  
    bankCode  
};

},

// ===================================================
// WITHDRAWAL
// ===================================================

withdraw(
p,
t,
b
) {

const amount =  
  Math.floor(  
    Number(  
      b.amount  
    )  
  );  

const accountNumber =  
  String(  
    b.accountNumber ||  
    ''  
  ).replace(  
    /\D/g,  
    ''  
  );  

const bankCode =  
  String(  
    b.bankCode ||  
    ''  
  ).trim();  

const accountName =  
  String(  
    b.accountName ||  
    ''  
  ).trim();  

if (  
  !(  
    amount >=  
      MIN_WITHDRAWAL &&  
    amount <=  
      MAX_WITHDRAWAL  
  )  
) {  
  return (  
    'Withdrawal must be between ₦' +  
    MIN_WITHDRAWAL +  
    ' and ₦' +  
    MAX_WITHDRAWAL  
  );  
}  

if (  
  R.bets[t]  
)  
  return 'Cash out your active bet first';  

if (  
  amount > p.bal  
)  
  return 'Not enough balance';  

if (  
  !/^\d{10}$/.test(  
    accountNumber  
  )  
)  
  return 'Enter a valid 10-digit account number';  

if (  
  !bankCode ||  
  !accountName  
)  
  return 'Resolve your bank account first';  

const reference =  
  'wd_' +  
  Date.now().toString(36) +  
  '_' +  
  crypto  
    .randomBytes(5)  
    .toString('hex');  

// Reserve balance immediately.  
p.bal =  
  r2(  
    p.bal -  
    amount  
  );  

const w = {  

  id:  
    txId(  
      'withdrawal'  
    ),  

  reference,  

  playerId:  
    p.id,  

  amount,  

  currency:  
    'NGN',  

  accountNumber,  

  bankCode,  

  accountName,  

  status:  
    'pending',  

  createdAt:  
    Date.now(),  

  updatedAt:  
    Date.now()  
};  

db.withdrawals.unshift(w);  

db.withdrawals.length =  
  Math.min(  
    db.withdrawals.length,  
    1000  
  );  

addTx(  
  p,  
  'withdrawal',  
  amount,  
  'pending',  
  {  
    reference,  
    withdrawalId:  
      w.id  
  }  
);  

save();  

if (  
  !REQUIRE_WITHDRAWAL_APPROVAL  
) {  

  setImmediate(  
    async () => {  

      try {  

        await createWithdrawalTransfer(  
          w  
        );  

      } catch (e) {  

        w.status =  
          'failed';  

        w.error =  
          e.message;  

        p.bal =  
          r2(  
            p.bal +  
            amount  
          );  

        const tx =  
          db.transactions.find(  
            x =>  
              x.reference ===  
              reference  
          );  

        if (tx)  
          tx.status =  
            'failed';  

        addTx(  
          p,  
          'withdrawal_refund',  
          amount,  
          'completed',  
          {  
            reference,  
            reason:  
              e.message  
          }  
        );  

        save();  
        broadcast();  
      }  

    }  
  );  
}  

return {  
  id: w.id,  
  reference,  
  status: w.status  
};

}

};

// =====================================================
// HTTP SERVER
// =====================================================

http.createServer(
(req, res) => {

const u =  
  new URL(  
    req.url,  
    'http://x'  
  );  


// =================================================  
// PAYSTACK WEBHOOK  
// =================================================  

if (  
  req.method === 'POST' &&  
  u.pathname ===  
    '/paystack/webhook'  
) {  

  let raw = '';  

  req.on(  
    'data',  
    x => {  

      raw += x;  

      if (  
        raw.length >  
        1000000  
      ) {  

        try {  
          req.destroy();  
        } catch (e) {}  

      }  

    }  
  );  

  req.on(  
    'end',  
    async () => {  

      try {  

        if (  
          !PAYSTACK_SECRET_KEY  
        )  
          return res  
            .writeHead(  
              503  
            )  
            .end(  
              'Paystack not configured'  
            );  

        const signature =  
          String(  
            req.headers[  
              'x-paystack-signature'  
            ] || ''  
          );  

        const expected =  
          crypto  
            .createHmac(  
              'sha512',  
              PAYSTACK_SECRET_KEY  
            )  
            .update(raw)  
            .digest(  
              'hex'  
            );  

        if (  
          !signature ||  
          signature.length !==  
            expected.length ||  
          !crypto.timingSafeEqual(  
            Buffer.from(  
              signature  
            ),  
            Buffer.from(  
              expected  
            )  
          )  
        ) {  

          return res  
            .writeHead(  
              401  
            )  
            .end(  
              'Invalid signature'  
            );  

        }  

        let event;  

        try {  
          event =  
            JSON.parse(  
              raw ||  
              '{}'  
            );  
        } catch (e) {  
          event = {};  
        }  


        // DEPOSIT  
        if (  
          event.event ===  
            'charge.success' &&  
          event.data &&  
          event.data.reference  
        ) {  

          try {  

            await creditVerifiedDeposit(  
              event.data.reference  
            );  

          } catch (e) {  

            console.error(  
              'Deposit webhook:',  
              e.message  
            );  

          }  

        }  


        // WITHDRAWAL  
        if (  
          (  
            event.event ===  
              'transfer.success' ||  
            event.event ===  
              'transfer.failed' ||  
            event.event ===  
              'transfer.reversed'  
          ) &&  
          event.data &&  
          event.data.reference  
        ) {  

          const w =  
            db.withdrawals.find(  
              x =>  
                x.reference ===  
                event.data.reference  
            );  

          if (w) {  

            const p =  
              findPlayerById(  
                w.playerId  
              );  

            const tx =  
              db.transactions.find(  
                x =>  
                  x.reference ===  
                  w.reference  
              );  

            if (  
              event.event ===  
              'transfer.success'  
            ) {  

              w.status =  
                'completed';  

              if (tx)  
                tx.status =  
                  'completed';  

            } else {  

              if (  
                w.status !==  
                  'refunded' &&  
                p  
              ) {  

                p.bal =  
                  r2(  
                    p.bal +  
                    w.amount  
                  );  

                addTx(  
                  p,  
                  'withdrawal_refund',  
                  w.amount,  
                  'completed',  
                  {  
                    reference:  
                      w.reference,  

                    reason:  
                      event.event  
                  }  
                );  
              }  

              w.status =  
                'refunded';  

              if (tx)  
                tx.status =  
                  'failed';  
            }  

            w.updatedAt =  
              Date.now();  

            save();  
            broadcast();  
          }  
        }  

        res.writeHead(  
          200,  
          {  
            'Content-Type':  
              'text/plain'  
          }  
        );  

        res.end('OK');  

      } catch (e) {  

        console.error(  
          'Webhook error:',  
          e  
        );  

        res  
          .writeHead(  
            500  
          )  
          .end(  
            'Webhook error'  
          );  
      }  

    }  
  );  

  return;  
}  


// =================================================  
// PAYSTACK CALLBACK  
// =================================================  

if (  
  u.pathname ===  
  '/paystack/callback'  
) {  

  const reference =  
    u.searchParams.get(  
      'reference'  
    ) || '';  

  res.writeHead(  
    200,  
    {  
      'Content-Type':  
        'text/html; charset=utf-8'  
    }  
  );  

  return res.end(  
    '<!doctype html>' +  
    '<html>' +  
    '<head>' +  
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +  
    '<title>Payment</title>' +  
    '</head>' +  
    '<body style="font-family:Arial;text-align:center;padding:40px">' +  
    '<h2>Payment received</h2>' +  
    '<p>Your payment is being verified. You can return to the game.</p>' +  
    '<p>Reference: ' +  
    String(  
      reference  
    ).replace(  
      /[<>&"']/g,  
      ''  
    ) +  
    '</p>' +  
    '</body>' +  
    '</html>'  
  );  
}  


// =================================================  
// SSE  
// =================================================  

if (  
  u.pathname ===  
  '/events'  
) {  

  const token =  
    u.searchParams.get(  
      'token'  
    );  

  if (  
    !player(  
      token,  
      u.searchParams.get(  
        'name'  
      ),  
      tgUser(  
        u.searchParams.get(  
          'tg'  
        )  
      )  
    )  
  ) {  

    res.writeHead(  
      400  
    );  

    return res.end();  
  }  

  res.writeHead(  
    200,  
    {  
      'Content-Type':  
        'text/event-stream',  

      'Cache-Control':  
        'no-cache',  

      Connection:  
        'keep-alive',  

      'X-Accel-Buffering':  
        'no'  
    }  
  );  

  const c = {  
    res,  
    token  
  };  

  conns.add(c);  

  res.on(  
    'close',  
    () => {  

      conns.delete(c);  

      const q =  
        db.players[  
          token  
        ];  

      if (q)  
        q.seen =  
          Date.now();  

    }  
  );  

  return send(c);  
}  


// =================================================  
// BANK LIST  
// =================================================  

if (  
  req.method === 'GET' &&  
  u.pathname ===  
    '/api/banks'  
) {  

  paystack(  
    'GET',  
    '/bank?country=nigeria&currency=NGN&perPage=100'  
  )  
    .then(  
      out => {  

        res.writeHead(  
          200,  
          {  
            'Content-Type':  
              'application/json'  
          }  
        );  

        res.end(  
          JSON.stringify({  
            ok: true,  
            banks:  
              out.data ||  
              []  
          })  
        );  

      }  
    )  
    .catch(  
      e => {  

        res.writeHead(  
          500,  
          {  
            'Content-Type':  
              'application/json'  
          }  
        );  

        res.end(  
          JSON.stringify({  
            ok: false,  
            error:  
              e.message  
          })  
        );  

      }  
    );  

  return;  
}  


// =================================================  
// PLAYER TRANSACTIONS  
// =================================================  

if (  
  req.method === 'GET' &&  
  u.pathname ===  
    '/api/transactions'  
) {  

  const token =  
    u.searchParams.get(  
      'token'  
    );  

  const p =  
    okToken(token) &&  
    db.players[token];  

  if (!p) {  

    res.writeHead(  
      401,  
      {  
        'Content-Type':  
          'application/json'  
      }  
    );  

    return res.end(  
      JSON.stringify({  
        ok: false,  
        error:  
          'Unknown player'  
      })  
    );  
  }  

  const items =  
    db.transactions  
      .filter(  
        t =>  
          t.playerId ===  
          p.id  
      )  
      .slice(  
        0,  
        50  
      );  

  res.writeHead(  
    200,  
    {  
      'Content-Type':  
        'application/json'  
    }  
  );  

  return res.end(  
    JSON.stringify({  
      ok: true,  
      transactions:  
        items  
    })  
  );  
}  


// =================================================  
// PLAYER API  
// =================================================  

if (  
  req.method === 'POST' &&  
  u.pathname.startsWith(  
    '/api/'  
  )  
) {  

  return jsonReq(  
    req,  
    10000  
  )  
    .then(  
      async b => {  

        const fn =  
          api[  
            u.pathname.slice(  
              5  
            )  
          ];  

        const p =  
          okToken(  
            b.token  
          ) &&  
          db.players[  
            b.token  
          ];  

        if (  
          !fn ||  
          !p  
        ) {  

          res.writeHead(  
            200,  
            {  
              'Content-Type':  
                'application/json'  
            }  
          );  

          return res.end(  
            JSON.stringify({  
              ok: false,  
              error:  
                'Unknown request'  
            })  
          );  
        }  

        let result;  

        try {  

          result =  
            await fn(  
              p,  
              b.token,  
              b  
            );  

        } catch (e) {  

          result =  
            e.message ||  
            'Request failed';  
        }  


        if (  
          result &&  
          typeof result ===  
            'object'  
        ) {  

          save();  
          broadcast();  

          res.writeHead(  
            200,  
            {  
              'Content-Type':  
                'application/json'  
            }  
          );  

          return res.end(  
            JSON.stringify({  
              ok: true,  
              ...result  
            })  
          );  
        }  


        if (!result) {  

          save();  
          broadcast();  

          res.writeHead(  
            200,  
            {  
              'Content-Type':  
                'application/json'  
            }  
          );  

          return res.end(  
            JSON.stringify({  
              ok: true  
            })  
          );  
        }  


        res.writeHead(  
          200,  
          {  
            'Content-Type':  
              'application/json'  
          }  
        );  

        res.end(  
          JSON.stringify({  
            ok: false,  
            error:  
              result  
          })  
        );  

      }  
    )  
    .catch(  
      e => {  

        res.writeHead(  
          400,  
          {  
            'Content-Type':  
              'application/json'  
          }  
        );  

        res.end(  
          JSON.stringify({  
            ok: false,  
            error:  
              e.message ||  
              'Bad request'  
          })  
        );  

      }  
    );  
}  


// =================================================  
// ADMIN PAGE  
// =================================================  

if (  
  u.pathname ===  
  '/admin'  
) {  

  return fs.readFile(  
    path.join(  
      __dirname,  
      'admin.html'  
    ),  
    (e, html) => {  

      res.writeHead(  
        e ? 500 : 200,  
        {  
          'Content-Type':  
            'text/html; charset=utf-8'  
        }  
      );  

      res.end(  
        e  
          ? 'admin.html missing'  
          : html  
      );  

    }  
  );  
}  


// =================================================  
// ADMIN API  
// =================================================  

if (  
  req.method === 'POST' &&  
  u.pathname.startsWith(  
    '/admin/api/'  
  )  
) {  

  return jsonReq(  
    req,  
    20000  
  )  
    .then(  
      async b => {  

        const h =  
          x =>  
            crypto  
              .createHash(  
                'sha256'  
              )  
              .update(  
                String(  
                  x || ''  
                )  
              )  
              .digest();  

        const out =  
          (  
            code,  
            o  
          ) => {  

            res.writeHead(  
              code,  
              {  
                'Content-Type':  
                  'application/json'  
              }  
            );  

            res.end(  
              JSON.stringify(o)  
            );  
          };  


        const a =  
          h(b.key);  

        const k =  
          h(ADMIN_KEY);  

        if (  
          a.length !==  
            k.length ||  
          !crypto.timingSafeEqual(  
            a,  
            k  
          )  
        ) {  

          return out(  
            401,  
            {  
              ok: false,  
              error:  
                'Wrong admin key'  
            }  
          );  
        }  


        const act =  
          u.pathname.slice(  
            11  
          );  


        // ADMIN STATE  
        if (  
          act ===  
          'state'  
        ) {  

          const on =  
            new Set(  
              [  
                ...conns  
              ].map(  
                c =>  
                  c.token  
              )  
            );  

          const players =  
            Object.entries(  
              db.players  
            ).map(  
              (  
                [  
                  t,  
                  p  
                ]  
              ) => ({  

                id: p.id,  
                name: p.name,  
                tg: p.tg,  
                email:  
                  p.email ||  
                  '',  
                bal: p.bal,  
                pnl: p.pnl,  

                rounds:  
                  p.st.r,  

                wins:  
                  p.st.w,  

                best:  
                  p.st.best,  

                bet:  
                  R.bets[t]  
                    ? {  
                        amt:  
                          R.bets[t]  
                            .amt,  

                        auto:  
                          R.bets[t]  
                            .auto,  

                        at:  
                          R.bets[t]  
                            .at  
                      }  
                    : null,  

                online:  
                  on.has(t),  

                first:  
                  p.first,  

                seen:  
                  p.seen  
              })  
            );  


          return out(  
            200,  
            {  
              ok: true,  
              online:  
                on.size,  

              total:  
                players.length,  

              round: {  
                id:  
                  R.id,  

                phase:  
                  R.phase,  

                bets:  
                  Object.keys(  
                    R.bets  
                  ).length  
              },  

              paystackConfigured:  
                !!PAYSTACK_SECRET_KEY,  

              requireWithdrawalApproval:  
                REQUIRE_WITHDRAWAL_APPROVAL,  

              players  
            }  
          );  
        }  


        // ADMIN TRANSACTIONS  
        if (  
          act ===  
          'transactions'  
        ) {  

          return out(  
            200,  
            {  
              ok: true,  
              transactions:  
                db.transactions  
                  .slice(  
                    0,  
                    200  
                  )  
            }  
          );  
        }  


        // ADMIN WITHDRAWALS  
        if (  
          act ===  
          'withdrawals'  
        ) {  

          return out(  
            200,  
            {  
              ok: true,  
              withdrawals:  
                db.withdrawals  
                  .slice(  
                    0,  
                    200  
                  )  
            }  
          );  
        }  


        // APPROVE WITHDRAWAL  
        if (  
          act ===  
          'approve-withdrawal'  
        ) {  

          const w =  
            db.withdrawals.find(  
              x =>  
                x.id ===  
                b.id  
            );  

          if (!w)  
            return out(  
              404,  
              {  
                ok: false,  
                error:  
                  'Withdrawal not found'  
              }  
            );  

          if (  
            w.status !==  
            'pending'  
          )  
            return out(  
              400,  
              {  
                ok: false,  
                error:  
                  'Withdrawal is not pending'  
              }  
            );  


          try {  

            await createWithdrawalTransfer(  
              w  
            );  

            return out(  
              200,  
              {  
                ok: true,  
                withdrawal:  
                  w  
              }  
            );  

          } catch (e) {  

            const p =  
              findPlayerById(  
                w.playerId  
              );  

            if (  
              p &&  
              w.status !==  
                'refunded'  
            ) {  

              p.bal =  
                r2(  
                  p.bal +  
                  w.amount  
                );  

              addTx(  
                p,  
                'withdrawal_refund',  
                w.amount,  
                'completed',  
                {  
                  reference:  
                    w.reference,  

                  reason:  
                    e.message  
                }  
              );  
            }  

            w.status =  
              'refunded';  

            w.error =  
              e.message;  

            w.updatedAt =  
              Date.now();  

            const tx =  
              db.transactions.find(  
                x =>  
                  x.reference ===  
                  w.reference  
              );  

            if (tx)  
              tx.status =  
                'failed';  

            save();  
            broadcast();  

            return out(  
              500,  
              {  
                ok: false,  
                error:  
                  e.message  
              }  
            );  
          }  
        }  


        // REJECT WITHDRAWAL  
        if (  
          act ===  
          'reject-withdrawal'  
        ) {  

          const w =  
            db.withdrawals.find(  
              x =>  
                x.id ===  
                b.id  
            );  

          if (!w)  
            return out(  
              404,  
              {  
                ok: false,  
                error:  
                  'Withdrawal not found'  
              }  
            );  

          if (  
            w.status !==  
            'pending'  
          )  
            return out(  
              400,  
              {  
                ok: false,  
                error:  
                  'Withdrawal is not pending'  
              }  
            );  

          const p =  
            findPlayerById(  
              w.playerId  
            );  

          if (p) {  

            p.bal =  
              r2(  
                p.bal +  
                w.amount  
              );  

            addTx(  
              p,  
              'withdrawal_refund',  
              w.amount,  
              'completed',  
              {  
                reference:  
                  w.reference,  

                reason:  
                  'admin_rejected'  
              }  
            );  
          }  

          w.status =  
            'rejected';  

          w.updatedAt =  
            Date.now();  

          const tx =  
            db.transactions.find(  
              x =>  
                x.reference ===  
                w.reference  
            );  

          if (tx)  
            tx.status =  
              'rejected';  

          save();  
          broadcast();  

          return out(  
            200,  
            {  
              ok: true  
            }  
          );  
        }  


        // LEGACY TEST CREDIT  
        if (  
          act ===  
          'restore'  
        ) {  

          const p =  
            Object.values(  
              db.players  
            ).find(  
              x =>  
                x.id ===  
                b.id  
            );  

          if (!p)  
            return out(  
              404,  
              {  
                ok: false,  
                error:  
                  'Player not found'  
              }  
            );  

          p.bal =  
            Math.max(  
              p.bal,  
              START  
            );  

          addTx(  
            p,  
            'test_credit',  
            START,  
            'completed',  
            {  
              reason:  
                'admin_restore'  
            }  
          );  

          save();  
          broadcast();  

          return out(  
            200,  
            {  
              ok: true  
            }  
          );  
        }  


        return out(  
          404,  
          {  
            ok: false,  
            error:  
              'Unknown request'  
          }  
        );  

      }  
    )  
    .catch(  
      e => {  

        res.writeHead(  
          400,  
          {  
            'Content-Type':  
              'application/json'  
          }  
        );  

        res.end(  
          JSON.stringify({  
            ok: false,  
            error:  
              e.message ||  
              'Bad request'  
          })  
        );  

      }  
    );  
}  


// =================================================  
// HISTORY  
// =================================================  

if (  
  u.pathname ===  
  '/api/history'  
) {  

  res.writeHead(  
    200,  
    {  
      'Content-Type':  
        'application/json'  
    }  
  );  

  return res.end(  
    JSON.stringify(  
      db.history  
    )  
  );  
}  


// =================================================  
// INDEX  
// =================================================  

fs.readFile(  
  path.join(  
    __dirname,  
    'index.html'  
  ),  
  (e, html) => {  

    if (e) {  

      res.writeHead(  
        500  
      );  

      return res.end(  
        'index.html missing'  
      );  
    }  

    res.writeHead(  
      200,  
      {  
        'Content-Type':  
          'text/html; charset=utf-8'  
      }  
    );  

    res.end(  
      html  
    );  

  }  
);

}
).listen(
PORT,
() =>
console.log(
'Live Crash running on port ' +
PORT
)
);

startRound();

console.log(
process.env.ADMIN_KEY
? 'Admin panel: /admin (key from ADMIN_KEY)'
: 'Admin panel: /admin   key: ' +
ADMIN_KEY
);

console.log(
PAYSTACK_SECRET_KEY
? 'Paystack wallet: CONFIGURED'
: 'Paystack wallet: NOT CONFIGURED — add PAYSTACK_SECRET_KEY in Render'
);
