// 서결 서명 페이지. 문서는 이 브라우저에서만 복호화된다. 열쇠(#k=)는 서버로 보내지 않는다.
// 문서 내용과 이름은 믿을 수 없는 입력으로 다룬다: DOM 에는 textContent 로만 넣는다.
// pdf.js 는 필요할 때 불러온다. 오래된 브라우저에서 실패해도 안내를 보여 줄 수 있게 한다.
let pdfjs = null;
async function loadPdf() {
  if (pdfjs) return pdfjs;
  try {
    if (!Promise.withResolvers) {
      Promise.withResolvers = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
    }
    pdfjs = await import("./pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "./pdf.worker.min.mjs";
    return pdfjs;
  } catch { throw new Problem("unsupported"); }
}

const API = "https://tajkcrgxwevbjfrhupal.supabase.co/functions/v1/seogyeol";
const $ = (id) => document.getElementById(id);
const utf8 = new TextEncoder();

// 새 형식: #비밀(16바이트). 예전 형식: #t=토큰&k=열쇠. 이미 보낸 링크가 있어 둘 다 받는다.
const fragment = location.hash.slice(1);
const params = new URLSearchParams(fragment);
const legacy = params.has("t");
const keyText = params.get("k") ?? "";
let token = params.get("t") ?? "";
let linkSecret = null, accessCode = "", proof = null;

let cryptoKey, envelopeId, signerId, manifest, docHash, manifestRev = 0, rosterMode = false;
let mine = [];              // 내 칸. {spec, text, image(base64), el}
const state = { focus: null };

// MARK: 암호

const fromB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
function toB64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}
const b64url = (bytes) => toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** 앱(RemoteCrypto)과 같은 계산: 비밀 하나에서 용도별 값을 따로 뽑아 토큰을 아는 서버가 열쇠를 못 만들게 한다 */
async function derive(info) {
  const base = await crypto.subtle.importKey("raw", linkSecret, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: utf8.encode("seogyeol-link-v1"), info: utf8.encode(info) }, base, 256));
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function decrypt(bytes, aad) {
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: utf8.encode(aad) }, cryptoKey, bytes.subarray(12)));
}
async function encrypt(bytes, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8.encode(aad) }, cryptoKey, bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return out;
}

async function api(body) {
  let res;
  try {
    res = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, token, ...(proof ? { proof } : {}), ...(rosterMode && signerId ? { signer_id: signerId } : {}) }) });
  } catch { throw new Problem("network"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Problem(data.error ?? "server_error", data.left);
  return data;
}

class Problem extends Error { constructor(code, left) { super(code); this.code = code; this.left = left; } }

const MESSAGES = {
  not_found: ["링크를 찾을 수 없습니다", "보낸 사람에게 다시 요청해 주십시오."],
  bad_link: ["링크가 올바르지 않습니다", "링크 전체가 복사되었는지 확인해 주십시오."],
  expired: ["서명 기한이 지났습니다", "보낸 사람에게 다시 요청해 주십시오."],
  cancelled: ["보낸 사람이 취소한 문서입니다", "더 이상 서명할 수 없습니다."],
  declined: ["서명이 중단된 문서입니다", "서명자 중 한 명이 거절했습니다."],
  code_locked: ["코드 입력 오류로 잠겼습니다", "보낸 사람에게 잠금 해제를 요청해 주십시오."],
  unsupported: ["이 브라우저에서는 열 수 없습니다", "운영체제나 브라우저를 업데이트한 뒤 다시 열어 주십시오."],
  removed: ["서명 대상에서 제외되었습니다", "자세한 내용은 보낸 사람에게 문의해 주십시오."],
  changed: ["문서 설정이 변경되었습니다", "이 링크를 다시 열어 서명해 주십시오."],
  already_signed: ["이미 서명했습니다", "같은 링크로 다시 서명할 수 없습니다."],
  completed: ["이미 완성된 문서입니다", "더 이상 서명을 받지 않습니다."],
  waiting: ["앞 순서 서명을 기다리고 있습니다", "앞 서명자가 완료한 뒤 다시 열어 주십시오."],
  network: ["연결할 수 없습니다", "인터넷 연결을 확인한 뒤 다시 열어 주십시오."],
  tampered: ["문서를 신뢰할 수 없습니다", "보낸 문서와 다릅니다. 서명하지 말고 보낸 사람에게 알려 주십시오."],
  server_error: ["일시적인 문제가 발생했습니다", "잠시 후 다시 시도해 주십시오."],
};

// 상태 표시용 선 아이콘. 이모지는 공적인 문서에 가벼워 보여 쓰지 않는다.
const ICONS = {
  check: ["M20 6 9 17l-5-5"],
  clock: ["M12 7v5l3 2", "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18"],
  alert: ["M12 9v4", "M12 17h.01", "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0"],
  list: ["M9 6h12", "M9 12h12", "M9 18h12", "M4 6h.01", "M4 12h.01", "M4 18h.01"],
  lock: ["M7 11V7a5 5 0 0 1 10 0v4", "M5 11h14v10H5z"],
  stop: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18", "M5.6 5.6l12.8 12.8"],
};

function iconNode(name) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", `mark ${name}`);
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name]) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

function notice(mark, title, text) {
  $("pages").hidden = true; $("bar").hidden = true;
  const box = $("notice");
  box.hidden = false;
  box.replaceChildren();
  const m = iconNode(mark);
  const h = document.createElement("h1"); h.textContent = title;
  const p = document.createElement("p"); p.textContent = text;
  box.append(m, h, p);
  return box;
}
const showProblem = (code) => { const [t, p] = MESSAGES[code] ?? MESSAGES.server_error; notice(code === "waiting" ? "clock" : "alert", t, p); };

// MARK: 시작

async function start() {
  try {
    if (legacy) {
      if (!token || !keyText) return showProblem("bad_link");
      // 잘린 열쇠는 다시 눌러도 소용없으니 서버 문제처럼 안내하지 않는다
      try { cryptoKey = await crypto.subtle.importKey("raw", fromB64(keyText), "AES-GCM", false, ["encrypt", "decrypt"]); }
      catch { return showProblem("bad_link"); }
    } else {
      if (!/^[A-Za-z0-9_-]{22}$/.test(fragment)) return showProblem("bad_link");
      linkSecret = fromB64(fragment);
      token = b64url(await derive("token"));
    }
    await openEnvelope();
  } catch (e) {
    showProblem(e instanceof Problem ? e.code : e.name === "OperationError" ? "bad_link" : "server_error");
  }
}

/** 접근 코드 입력. 틀린 횟수는 서버가 센다. */
function askCode(message) {
  const box = notice("lock", "접근 코드를 입력해 주십시오", message ?? "보낸 사람에게 별도로 받은 6자리 코드입니다.");
  const input = document.createElement("input");
  input.type = "text"; input.inputMode = "numeric"; input.autocomplete = "off";
  input.className = "code-input"; input.setAttribute("aria-label", "접근 코드");
  const go = document.createElement("button");
  go.type = "button"; go.className = "primary"; go.textContent = "확인"; go.disabled = true;
  input.addEventListener("input", () => { input.value = input.value.replace(/\D/g, "").slice(0, 6); go.disabled = input.value.length !== 6; });
  const submit = async () => {
    if (go.disabled) return;
    go.disabled = true;
    accessCode = input.value;
    try {
      proof = b64url(await derive(`proof|${accessCode}`));
      await openEnvelope();
    } catch (e) {
      showProblem(e instanceof Problem ? e.code : "server_error");
    }
  };
  go.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  box.append(input, go);
  input.focus();
}

async function openEnvelope() {
  let opened;
  try {
    opened = await api({ action: "open" });
  } catch (e) {
    if (e instanceof Problem && e.code === "code_required") return askCode();
    if (e instanceof Problem && e.code === "code_wrong") return askCode(`코드가 일치하지 않습니다. ${e.left}회 더 틀리면 잠깁니다.`);
    throw e;
  }
  try {
    if (opened.state === "waiting") return showProblem("waiting");
    envelopeId = opened.envelope_id; signerId = opened.signer_id; manifestRev = opened.rev ?? 0;
    if (opened.can_decline === false) $("decline").hidden = true;
    if (!legacy) {
      // 서버가 내준 감싼 열쇠를 링크 비밀로 푼다. 서버는 이 열쇠를 만들 수 없다.
      const wrap = await crypto.subtle.importKey("raw", await derive(`wrap|${accessCode}`), "AES-GCM", false, ["decrypt"]);
      const sealed = fromB64(opened.wrapped_key);
      const raw = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: sealed.subarray(0, 12), additionalData: utf8.encode(`wrap:${envelopeId}:${signerId ?? "group"}`) }, wrap, sealed.subarray(12));
      cryptoKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    }
    if (opened.state === "roster") {
      manifest = JSON.parse(new TextDecoder().decode(await decrypt(fromB64(opened.manifest), `manifest:${envelopeId}`)));
      document.title = `${manifest.title} · 서결`;
      return showRoster(opened);
    }
    manifest = JSON.parse(new TextDecoder().decode(await decrypt(fromB64(opened.manifest), `manifest:${envelopeId}`)));
    document.title = `${manifest.title} · 서결`;
    if (opened.state === "signed") return showSigned(opened.signed_at, opened.final_url);
    await openDocument(opened.doc_url);
  } catch (e) {
    showProblem(e instanceof Problem ? e.code : e.name === "OperationError" ? "bad_link" : "server_error");
  }
}

/** 명단 공유 링크: 자기 이름을 골라 서명한다 */
function showRoster(opened) {
  rosterMode = true;
  if (opened.final_url) return showSigned(null, opened.final_url, false, true);
  const box = notice("list", manifest.title, `${manifest.from}님이 보낸 명단입니다. 이름을 선택해 서명해 주십시오.`);
  const status = new Map(opened.signers.map((s) => [s.id, s.status]));
  const list = document.createElement("div");
  list.className = "roster";
  const pick = async (id) => {
    signerId = id;
    box.replaceChildren();
    const spin = document.createElement("div"); spin.className = "spinner"; box.append(spin);
    try {
      // 서명 URL 은 한 시간 뒤 만료되니 회의 중 오래 열어 뒀어도 되도록 고를 때 새로 받는다
      const fresh = await api({ action: "open" });
      // 열어 둔 사이 명단이 바뀌었을 수 있으니 최신 칸으로 서명한다
      manifest = JSON.parse(new TextDecoder().decode(await decrypt(fromB64(fresh.manifest), `manifest:${envelopeId}`)));
      manifestRev = fresh.rev ?? 0;
      $("decline").hidden = true;
      await openDocument(fresh.doc_url);
    } catch (e) { showProblem(e instanceof Problem ? e.code : "server_error"); }
  };
  // 양식의 빈 줄: 이름이 없는 사람은 빈 줄 하나를 차지해 직접 적는다
  // 같은 QR 을 여러 명이 동시에 열어도 부딪히지 않게 남은 줄 중 하나를 무작위로 고른다
  const blanks = manifest.signers.filter((p) => p.blank && status.has(p.id) && status.get(p.id) !== "signed");
  const blank = blanks[Math.floor(Math.random() * blanks.length)];
  for (const person of manifest.signers) {
    if (!status.has(person.id) || person.blank) continue;
    const b = document.createElement("button");
    b.type = "button";
    const name = document.createElement("span"); name.textContent = person.name;
    const state = document.createElement("span"); state.className = "state";
    const done = status.get(person.id) === "signed";
    state.textContent = done ? "서명함" : "서명하기";
    b.append(name, state);
    b.disabled = done;
    b.addEventListener("click", () => pick(person.id));
    list.append(b);
  }
  if (blank) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "blank-row";
    const name = document.createElement("span"); name.textContent = "명단에 이름이 없는 경우";
    const state = document.createElement("span"); state.className = "state"; state.textContent = "이름 쓰고 서명";
    b.append(name, state);
    b.addEventListener("click", () => pick(blank.id));
    list.append(b);
  }
  box.append(list);
}

async function fetchBytes(url) {
  let res;
  try { res = await fetch(url); } catch { throw new Problem("network"); }
  if (!res.ok) throw new Problem("not_found");
  return new Uint8Array(await res.arrayBuffer());
}

async function openDocument(url) {
  const pdfBytes = await decrypt(await fetchBytes(url), `doc:${envelopeId}`);
  docHash = hex(await crypto.subtle.digest("SHA-256", pdfBytes));
  if (docHash !== manifest.doc_sha256) throw new Problem("tampered");

  const me = manifest.signers.find((s) => s.id === signerId);
  const today = new Date();
  const todayText = `${today.getFullYear()}년 ${today.getMonth() + 1}월 ${today.getDate()}일`;
  mine = manifest.fields.filter((f) => f.signer === signerId).map((spec) => ({
    spec,
    image: null,
    // 빈 줄은 이름을 직접 적는다
    text: spec.kind === "name" ? (me?.blank ? null : me?.name) : spec.kind === "email" ? (me?.email || null) : spec.kind === "date" ? todayText : null,
    el: null,
  }));

  $("title").textContent = manifest.title;
  $("from").textContent = `${manifest.from}님의 서명 요청`;
  $("who").textContent = me?.blank ? "이름을 입력해 주십시오" : (me?.name ?? "");
  $("consent").checked = false;
  $("top").hidden = false;
  $("notice").hidden = true;
  $("pages").hidden = false;   // 코드 입력 화면을 거쳐 오면 숨겨져 있다
  $("bar").hidden = false;

  // pdf.js 는 받은 버퍼를 워커로 넘기므로 복사본을 준다
  const lib = await loadPdf();
  const doc = await lib.getDocument({
    data: pdfBytes.slice(), isEvalSupported: false, cMapUrl: "./cmaps/", cMapPacked: true, standardFontDataUrl: "./standard_fonts/",
  }).promise;
  await layoutPages(doc);
  refreshBar();
  // 서명할 곳이 뒤쪽 쪽에 있어도 바로 찾게 첫 칸으로 데려간다
  const first = mine.find((f) => !satisfied(f));
  if (first) focusField(first);
}

// MARK: 페이지

async function layoutPages(doc) {
  const host = $("pages");
  const painter = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { painter.unobserve(e.target); e.target.paint(); }
  }, { rootMargin: "600px" });

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });   // 회전과 크롭을 반영한 보이는 크기
    const box = document.createElement("div");
    box.className = "page";
    box.style.aspectRatio = `${base.width} / ${base.height}`;
    box.style.width = "100%";
    box.style.maxWidth = `${Math.max(base.width * 1.5, 420)}px`;
    const canvas = document.createElement("canvas");
    box.append(canvas);
    box.paint = async () => {
      const width = Math.min(box.clientWidth * Math.max(window.devicePixelRatio || 1, 2), 2200);
      const viewport = page.getViewport({ scale: width / base.width });
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    };
    for (const f of mine.filter((m) => m.spec.page === n - 1)) box.append(makeField(f));
    host.append(box);
    painter.observe(box);
  }
}

function makeField(f) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `field ${f.spec.kind}`;
  el.style.left = `${f.spec.x * 100}%`;
  el.style.top = `${f.spec.y * 100}%`;
  el.style.width = `${f.spec.w * 100}%`;
  el.style.height = `${f.spec.h * 100}%`;
  el.addEventListener("click", () => openInput(f));
  f.el = el;
  paintField(f);
  return el;
}

const fieldTitle = (spec) => spec.label || KIND[spec.kind];
const KIND = { signature: "서명", initials: "이니셜", stamp: "도장", name: "이름", date: "날짜", email: "이메일", text: "글자", checkbox: "체크" };
const isImage = (k) => k === "signature" || k === "initials" || k === "stamp";
const filled = (f) => isImage(f.spec.kind) ? !!f.image : f.spec.kind === "checkbox" ? f.text === "true" : !!f.text;
const satisfied = (f) => filled(f) || !f.spec.required;

function paintField(f) {
  const el = f.el;
  el.replaceChildren();
  el.classList.toggle("filled", filled(f));
  el.classList.toggle("focus", state.focus === f);
  el.setAttribute("aria-label", `${fieldTitle(f.spec)}${f.spec.required ? "" : "(선택)"}${filled(f) ? ", 입력됨" : ", 비어 있음"}`);
  if (f.spec.kind === "checkbox") {
    el.textContent = f.text === "true" ? "✓" : "";
  } else if (isImage(f.spec.kind) && f.image) {
    const img = document.createElement("img");
    img.alt = "";
    img.src = `data:image/png;base64,${f.image}`;
    el.append(img);
  } else if (f.text) {
    const v = document.createElement("span"); v.className = "value"; v.textContent = f.text;
    el.append(v);
  } else {
    const l = document.createElement("span"); l.className = "label"; l.textContent = fieldTitle(f.spec) + (f.spec.required ? "" : "(선택)");
    el.append(l);
  }
}

function refreshBar() {
  const left = mine.filter((f) => !satisfied(f));
  $("progress").textContent = `${mine.length - left.length}/${mine.length}칸`;
  $("next").hidden = left.length === 0;
  $("finish").hidden = left.length > 0;
  $("consent-row").hidden = left.length > 0;
  $("finish").disabled = !$("consent").checked;
}

function focusField(f) {
  const before = state.focus;
  state.focus = f;
  if (before) paintField(before);
  if (f) { paintField(f); f.el.scrollIntoView({ behavior: "smooth", block: "center" }); }
}

$("next").addEventListener("click", () => {
  const left = mine.filter((f) => !satisfied(f));
  if (!left.length) return refreshBar();
  // 보고 있는 칸이 비어 있으면 바로 입력을 연다. 눌러야 할 곳을 찾아 헤매지 않게 한다.
  if (left.includes(state.focus)) return openInput(state.focus);
  focusField(left[0]);
});
$("consent").addEventListener("change", refreshBar);

// MARK: 입력

const dialog = $("input");
let commit = null;

function openInput(f) {
  focusField(f);
  if (f.spec.kind === "checkbox") {
    f.text = f.text === "true" ? "false" : "true";
    paintField(f); refreshBar();
    return;
  }
  const body = $("input-body");
  body.replaceChildren();
  $("input-title").textContent = fieldTitle(f.spec);
  $("input-clear").hidden = true;
  $("input-ok").disabled = false;
  if (f.spec.kind === "stamp") commit = stampInput(f, body);
  else if (isImage(f.spec.kind)) commit = padInput(f, body);
  else commit = textInput(f, body);
  dialog.showModal();
  dialog.scrollTop = 0;
}

function textInput(f, body) {
  const input = document.createElement("input");
  input.type = f.spec.kind === "email" ? "email" : "text";
  input.maxLength = 200;
  input.value = f.text ?? "";
  body.append(input);
  setTimeout(() => input.focus(), 50);
  return () => { f.text = input.value.trim() || null; };
}

function padInput(f, body) {
  const pad = document.createElement("canvas");
  pad.className = "pad";
  pad.setAttribute("aria-label", "여기에 서명해 주십시오");
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "손가락이나 마우스로 서명해 주십시오.";
  body.append(pad, hint);
  const ctx = pad.getContext("2d");
  let scale = 1, strokes = [], current = null;

  const size = () => {
    scale = window.devicePixelRatio || 1;
    pad.width = pad.clientWidth * scale; pad.height = pad.clientHeight * scale;
    redraw();
  };
  const line = (c, pts) => {
    c.lineWidth = 3 * scale; c.lineCap = "round"; c.lineJoin = "round"; c.strokeStyle = "#111";
    c.beginPath();
    pts.forEach(([x, y], i) => {
      if (i === 0) c.moveTo(x, y);
      else { const [a, b] = pts[i - 1]; c.quadraticCurveTo(a, b, (a + x) / 2, (b + y) / 2); }
    });
    if (pts.length === 1) c.lineTo(pts[0][0] + .1, pts[0][1]);
    c.stroke();
  };
  const redraw = () => { ctx.clearRect(0, 0, pad.width, pad.height); strokes.forEach((s) => line(ctx, s)); };
  const at = (e) => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * scale, (e.clientY - r.top) * scale]; };

  pad.addEventListener("pointerdown", (e) => { pad.setPointerCapture(e.pointerId); current = [at(e)]; strokes.push(current); redraw(); sync(); });
  pad.addEventListener("pointermove", (e) => { if (current) { current.push(at(e)); redraw(); } });
  const up = () => { current = null; sync(); };
  pad.addEventListener("pointerup", up);
  pad.addEventListener("pointercancel", up);
  const sync = () => { $("input-ok").disabled = strokes.length === 0; };

  const clear = $("input-clear");
  clear.hidden = false;
  clear.onclick = () => { strokes = []; redraw(); sync(); };
  requestAnimationFrame(size);
  $("input-ok").disabled = true;

  return () => {
    // 그린 곳만 잘라 투명 PNG 로 만든다
    const xs = strokes.flat().map((p) => p[0]), ys = strokes.flat().map((p) => p[1]);
    const m = 8 * scale;
    const x0 = Math.max(0, Math.min(...xs) - m), y0 = Math.max(0, Math.min(...ys) - m);
    const x1 = Math.min(pad.width, Math.max(...xs) + m), y1 = Math.min(pad.height, Math.max(...ys) + m);
    const out = document.createElement("canvas");
    out.width = Math.max(1, x1 - x0); out.height = Math.max(1, y1 - y0);
    const c = out.getContext("2d");
    c.translate(-x0, -y0);
    strokes.forEach((s) => line(c, s));
    f.image = out.toDataURL("image/png").split(",")[1];
  };
}

/** 이름으로 도장 모양을 만든다(앱의 StampMaker 와 같은 배치: 오른쪽 위부터 세로로) */
function drawStamp(canvas, name) {
  const side = 600;
  canvas.width = canvas.height = side;
  const c = canvas.getContext("2d");
  c.clearRect(0, 0, side, side);
  const chars = [...name.trim()];
  if (!chars.length) return false;
  const cells = chars.length === 3 ? [...chars, "인"] : chars;
  const columns = cells.length <= 2 ? 1 : Math.ceil(cells.length / 2);
  const rows = Math.ceil(cells.length / columns);
  const ink = "#c21f1c";
  c.strokeStyle = ink; c.lineWidth = 24;
  c.beginPath(); c.arc(side / 2, side / 2, side / 2 - 30, 0, Math.PI * 2); c.stroke();
  const area = 408, cw = area / columns, ch = area / rows;
  c.fillStyle = ink; c.textAlign = "center"; c.textBaseline = "middle";
  c.font = `700 ${Math.min(cw, ch) * .92}px "Apple SD Gothic Neo", "Noto Serif KR", "Malgun Gothic", serif`;
  cells.forEach((ch1, i) => {
    const col = columns - 1 - Math.floor(i / rows), row = i % rows;
    c.fillText(ch1, 96 + cw * (col + .5), 96 + ch * (row + .5));
  });
  return true;
}

function stampInput(f, body) {
  const me = manifest.signers.find((s) => s.id === signerId);
  const input = document.createElement("input");
  input.type = "text"; input.maxLength = 8; input.value = me?.name ?? ""; input.placeholder = "도장에 새길 이름";
  const preview = document.createElement("canvas");
  preview.className = "stamp-preview";
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "이름으로 만든 도장 이미지이며, 등록 인감이 아닙니다.";
  body.append(input, preview, hint);
  const sync = () => { $("input-ok").disabled = !drawStamp(preview, input.value); };
  input.addEventListener("input", sync);
  sync();
  return () => { f.image = preview.toDataURL("image/png").split(",")[1]; };
}

$("input-ok").addEventListener("click", () => {
  if ($("input-ok").disabled) return;
  commit?.(); dialog.close(); paintField(state.focus); refreshBar();
  const next = mine.find((f) => !satisfied(f));
  if (next) focusField(next);
});
// 글자 칸에서 키보드의 완료·이동을 누르면 입력이 사라지지 않고 넣기로 처리한다
$("input-form").addEventListener("submit", (e) => { e.preventDefault(); $("input-ok").click(); });
$("input-cancel").addEventListener("click", () => dialog.close());

// MARK: 제출

const fieldShape = (f) => [f.id, f.page, f.x, f.y, f.w, f.h, f.kind, f.required].join("|");

/**
 * 보던 사이 보낸 사람이 명단이나 칸을 고쳤을 때. 내 칸이 그대로이면 사람이 다시 할 일이 없으니 새 판으로 조용히 다시 보낸다.
 * 내 칸이 바뀌었으면 false: 바뀐 칸을 보고 다시 서명해야 한다.
 */
async function catchUp() {
  const fresh = await api({ action: "open" });
  if (!fresh.manifest) return false;
  const latest = JSON.parse(new TextDecoder().decode(await decrypt(fromB64(fresh.manifest), `manifest:${envelopeId}`)));
  const shape = (m) => m.fields.filter((f) => f.signer === signerId).map(fieldShape).sort().join("\n");
  if (!shape(latest) || shape(latest) !== shape(manifest)) return false;
  manifest = latest;
  manifestRev = fresh.rev ?? 0;
  return true;
}

/** 빈 줄을 동시에 고른 사람이 먼저 서명했으면, 다시 그리게 하지 않고 남은 다른 빈 줄로 옮긴다 */
async function moveToAnotherBlank() {
  if (!manifest.signers.find((p) => p.id === signerId)?.blank) return false;
  const fresh = await api({ action: "open" });
  if (!fresh.signers) return false;
  const latest = JSON.parse(new TextDecoder().decode(await decrypt(fromB64(fresh.manifest), `manifest:${envelopeId}`)));
  const left = new Set(fresh.signers.filter((s) => s.status !== "signed").map((s) => s.id));
  const key = (spec) => `${spec.kind}|${spec.label ?? ""}|${spec.required}`;
  const wanted = mine.map((f) => key(f.spec)).sort().join("\n");
  for (const person of latest.signers.filter((p) => p.blank && left.has(p.id) && p.id !== signerId)) {
    const specs = latest.fields.filter((f) => f.signer === person.id);
    if (specs.map(key).sort().join("\n") !== wanted) continue;
    for (const f of mine) f.spec = specs.splice(specs.findIndex((s) => key(s) === key(f.spec)), 1)[0];
    signerId = person.id;
    manifest = latest;
    manifestRev = fresh.rev ?? 0;
    return true;
  }
  return false;
}

const CONSENT = "문서를 읽었고, 전자적으로 서명하는 데 동의합니다. 서명 시각과 IP·브라우저 정보가 기록에 남습니다.";

$("finish").addEventListener("click", async () => {
  if (!$("consent").checked || mine.some((f) => !satisfied(f))) return;
  const button = $("finish");
  button.disabled = true; button.textContent = "보내는 중…";
  try {
    // 칸 id 와 서명자가 바뀔 수 있어 보낼 때마다 새로 봉한다
    const send = async () => {
      const payload = {
        v: 1, doc_sha256: docHash, consent: CONSENT, signed_at_client: new Date().toISOString(),
        fields: mine.map((f) => ({ id: f.spec.id, text: isImage(f.spec.kind) ? null : f.text, image: f.image })),
      };
      const sealed = await encrypt(utf8.encode(JSON.stringify(payload)), `result:${envelopeId}:${signerId}`);
      return api({ action: "submit", consent: true, doc_hash: docHash, result: toB64(sealed), rev: manifestRev });
    };
    let done;
    for (let tries = 0; !done; tries++) {
      try {
        done = await send();
      } catch (e) {
        const again = tries < 4 && e instanceof Problem &&
          (e.code === "changed" ? await catchUp() : e.code === "already_signed" && rosterMode ? await moveToAnotherBlank() : false);
        if (!again) throw e;
      }
    }
    showSigned(done.signed_at, null, rosterMode);
  } catch (e) {
    const code = e instanceof Problem ? e.code : "server_error";
    if (code === "network" || code === "server_error" || code === "code_locked") {
      // 입력을 잃지 않고 다시 시도할 수 있게 둔다
      button.disabled = false; button.textContent = "서명 완료";
      alert(code === "code_locked"
        ? "링크가 잠겼습니다. 보낸 사람에게 잠금 해제를 요청한 뒤 다시 눌러 주십시오. 입력 내용은 유지됩니다."
        : "전송하지 못했습니다. 입력 내용은 유지되니 연결을 확인하고 다시 눌러 주십시오.");
    } else if (code === "already_signed" && rosterMode) {
      // 빈 줄은 여러 사람이 동시에 고를 수 있다. 막다른 안내 대신 명단으로 돌아갈 길을 준다.
      const box = notice("alert", "이미 서명된 줄입니다", "명단을 다시 열어 확인해 주십시오.");
      const b = document.createElement("button");
      b.type = "button"; b.className = "primary"; b.textContent = "명단 다시 열기";
      b.addEventListener("click", () => location.reload());
      box.append(b);
      $("top").hidden = true;
    } else showProblem(code);
  }
});

function showSigned(at, finalUrl, offerNext = false, rosterDone = false) {
  $("top").hidden = true;
  const when = at ? new Date(at).toLocaleString("ko-KR") : "";
  // 명단이 끝난 뒤 공유 링크를 연 사람은 서명했는지 알 수 없다. 서명을 마쳤다고 말하지 않는다.
  const box = notice("check", rosterDone ? "완성된 명단입니다" : "서명이 완료되었습니다", rosterDone
    ? "서명이 종료된 문서입니다. 완성본을 내려받을 수 있습니다."
    : finalUrl
    ? "모든 서명이 완료되었습니다. 완성본을 내려받아 보관해 주십시오."
    : `${when}에 기록되었습니다. 모든 서명이 완료되면 이 링크에서 완성본을 받을 수 있습니다.`);
  if (finalUrl) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "primary"; b.textContent = "완성본 내려받기";
    b.addEventListener("click", () => downloadFinal(finalUrl, b));
    box.append(b);
  }
  if (offerNext) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "ghost"; b.textContent = "이 기기로 다른 사람도 서명하기";
    b.addEventListener("click", () => location.reload());
    box.append(b);
  }
}

async function downloadFinal(url, button) {
  button.disabled = true;
  try {
    const pdf = await decrypt(await fetchBytes(url), `final:${envelopeId}`);
    const hash = hex(await crypto.subtle.digest("SHA-256", pdf));
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([pdf], { type: "application/pdf" }));
    link.download = `${manifest.title.replace(/[\\/:*?"<>|]/g, "-")}_서명완료.pdf`;
    document.body.append(link);
    link.click();
    link.remove();
    button.parentElement.querySelector(".download-info")?.remove();
    const info = document.createElement("div");
    info.className = "download-info";
    const hint = document.createElement("p");
    hint.textContent = "파일이 받아지지 않으면 Safari나 Chrome에서 열어 주십시오.";
    const c = document.createElement("code");
    c.textContent = `SHA-256 ${hash}`;
    info.append(hint, c);
    button.after(info);
  } catch (e) {
    alert("내려받지 못했습니다. 페이지를 다시 열어 주십시오.");
  } finally { button.disabled = false; }
}

// MARK: 거절

$("decline").addEventListener("click", () => $("decline-dialog").showModal());
$("decline-cancel").addEventListener("click", () => $("decline-dialog").close());
$("decline-ok").addEventListener("click", async () => {
  $("decline-dialog").close();
  try {
    const reason = $("decline-reason").value.trim();
    const sealed = reason ? toB64(await encrypt(utf8.encode(reason), `decline:${envelopeId}:${signerId}`)) : null;
    await api({ action: "decline", reason: sealed });
    notice("stop", "서명을 거절했습니다", "보낸 사람에게 전달됩니다.");
    $("top").hidden = true;
  } catch (e) { showProblem(e instanceof Problem ? e.code : "server_error"); }
});

// 링크가 모두 같은 주소에 # 뒤만 달라, 다른 링크를 붙여 넣어도 새로 읽지 않는다
addEventListener("hashchange", () => location.reload());

start();
