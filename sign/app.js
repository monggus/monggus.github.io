// 서결 서명 페이지. 문서는 이 브라우저에서만 복호화된다. 열쇠(#k=)는 서버로 보내지 않는다.
// 문서 내용과 이름은 믿을 수 없는 입력으로 다룬다: DOM 에는 textContent 로만 넣는다.
import * as pdfjs from "./pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = "./pdf.worker.min.mjs";

const API = "https://tajkcrgxwevbjfrhupal.supabase.co/functions/v1/seogyeol";
const $ = (id) => document.getElementById(id);
const utf8 = new TextEncoder();

const params = new URLSearchParams(location.hash.slice(1));
const token = params.get("t") ?? "";
const keyText = params.get("k") ?? "";

let cryptoKey, envelopeId, signerId, manifest, docHash, rosterUrl = null;
let mine = [];              // 내 칸. {spec, text, image(base64), el}
const state = { focus: null };

// MARK: 암호

const fromB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
function toB64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
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
    res = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, token, ...(rosterUrl ? { signer_id: signerId } : {}) }) });
  } catch { throw new Problem("network"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Problem(data.error ?? "server_error");
  return data;
}

class Problem extends Error { constructor(code) { super(code); this.code = code; } }

const MESSAGES = {
  not_found: ["링크를 찾을 수 없어요", "링크가 잘렸거나 문서가 삭제됐을 수 있어요. 보낸 사람에게 다시 요청해 주세요."],
  bad_link: ["링크가 올바르지 않아요", "메시지의 링크 전체가 복사됐는지 확인해 주세요."],
  expired: ["서명 기한이 지났어요", "보낸 사람에게 다시 요청해 주세요."],
  cancelled: ["보낸 사람이 취소한 문서예요", "더 이상 서명할 수 없어요."],
  declined: ["서명이 중단된 문서예요", "서명자 중 한 명이 거절했어요."],
  already_signed: ["이미 서명했어요", "같은 링크로 다시 서명할 수 없어요."],
  completed: ["이미 완성된 문서예요", "서명을 더 받지 않아요."],
  waiting: ["앞 순서 서명을 기다리고 있어요", "앞 서명자가 끝나면 이 링크로 서명할 수 있어요. 나중에 다시 열어 주세요."],
  network: ["연결할 수 없어요", "인터넷 연결을 확인한 뒤 다시 열어 주세요. 서버가 잠시 멈춰 있을 수도 있어요."],
  tampered: ["문서를 믿을 수 없어요", "내려받은 문서가 보낸 문서와 달라요. 서명하지 말고 보낸 사람에게 알려 주세요."],
  server_error: ["잠시 문제가 생겼어요", "조금 뒤 다시 시도해 주세요."],
};

// 상태 표시용 선 아이콘. 이모지는 공적인 문서에 가벼워 보여 쓰지 않는다.
const ICONS = {
  check: ["M20 6 9 17l-5-5"],
  clock: ["M12 7v5l3 2", "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18"],
  alert: ["M12 9v4", "M12 17h.01", "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0"],
  list: ["M9 6h12", "M9 12h12", "M9 18h12", "M4 6h.01", "M4 12h.01", "M4 18h.01"],
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
  if (!token || !keyText) return showProblem("bad_link");
  try {
    cryptoKey = await crypto.subtle.importKey("raw", fromB64(keyText), "AES-GCM", false, ["encrypt", "decrypt"]);
    const opened = await api({ action: "open" });
    if (opened.state === "waiting") return showProblem("waiting");
    envelopeId = opened.envelope_id; signerId = opened.signer_id;
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
  if (opened.final_url) return showSigned(null, opened.final_url);
  rosterUrl = opened.doc_url;
  const box = notice("list", manifest.title, `${manifest.from}님이 보낸 명단이에요. 내 이름을 골라 서명해 주세요.`);
  const status = new Map(opened.signers.map((s) => [s.id, s.status]));
  const list = document.createElement("div");
  list.className = "roster";
  for (const person of manifest.signers) {
    if (!status.has(person.id)) continue;
    const b = document.createElement("button");
    b.type = "button";
    const name = document.createElement("span"); name.textContent = person.name;
    const state = document.createElement("span"); state.className = "state";
    const done = status.get(person.id) === "signed";
    state.textContent = done ? "서명함" : "서명하기";
    b.append(name, state);
    b.disabled = done;
    b.addEventListener("click", async () => {
      signerId = person.id;
      box.replaceChildren(); $("pages").hidden = false;
      const spin = document.createElement("div"); spin.className = "spinner"; box.append(spin);
      try { await openDocument(rosterUrl); $("decline").hidden = true; }
      catch (e) { showProblem(e instanceof Problem ? e.code : "server_error"); }
    });
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
    text: spec.kind === "name" ? me?.name : spec.kind === "email" ? (me?.email || null) : spec.kind === "date" ? todayText : null,
    el: null,
  }));

  $("title").textContent = manifest.title;
  $("from").textContent = `${manifest.from}님이 서명을 요청했어요`;
  $("who").textContent = me?.name ?? "";
  $("top").hidden = false;
  $("notice").hidden = true;
  $("bar").hidden = false;

  // pdf.js 는 받은 버퍼를 워커로 넘기므로 복사본을 준다
  const doc = await pdfjs.getDocument({
    data: pdfBytes.slice(), isEvalSupported: false, cMapUrl: "./cmaps/", cMapPacked: true, standardFontDataUrl: "./standard_fonts/",
  }).promise;
  await layoutPages(doc);
  refreshBar();
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

const KIND = { signature: "서명", initials: "이니셜", stamp: "도장", name: "이름", date: "날짜", email: "이메일", text: "글자", checkbox: "체크" };
const isImage = (k) => k === "signature" || k === "initials" || k === "stamp";
const filled = (f) => isImage(f.spec.kind) ? !!f.image : f.spec.kind === "checkbox" ? f.text === "true" : !!f.text;
const satisfied = (f) => filled(f) || !f.spec.required;

function paintField(f) {
  const el = f.el;
  el.replaceChildren();
  el.classList.toggle("filled", filled(f));
  el.classList.toggle("focus", state.focus === f);
  el.setAttribute("aria-label", `${KIND[f.spec.kind]}${f.spec.required ? "" : "(선택)"}${filled(f) ? ", 입력됨" : ", 비어 있음"}`);
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
    const l = document.createElement("span"); l.className = "label"; l.textContent = KIND[f.spec.kind] + (f.spec.required ? "" : "(선택)");
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
  const i = left.indexOf(state.focus);
  focusField(left[(i + 1) % left.length]);
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
  $("input-title").textContent = KIND[f.spec.kind];
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
  pad.setAttribute("aria-label", "여기에 서명을 그려 주세요");
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "손가락이나 마우스로 그려 주세요.";
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
  hint.textContent = "이름으로 만든 도장 모양이에요. 등록된 인감과는 달라요.";
  body.append(input, preview, hint);
  const sync = () => { $("input-ok").disabled = !drawStamp(preview, input.value); };
  input.addEventListener("input", sync);
  sync();
  return () => { f.image = preview.toDataURL("image/png").split(",")[1]; };
}

$("input-ok").addEventListener("click", () => { commit?.(); dialog.close(); paintField(state.focus); refreshBar(); });
$("input-cancel").addEventListener("click", () => dialog.close());

// MARK: 제출

const CONSENT = "문서를 읽었고, 전자적으로 서명하는 데 동의합니다. 서명 시각과 IP·브라우저 정보가 기록에 남습니다.";

$("finish").addEventListener("click", async () => {
  if (!$("consent").checked || mine.some((f) => !satisfied(f))) return;
  const button = $("finish");
  button.disabled = true; button.textContent = "보내는 중…";
  try {
    const payload = {
      v: 1, doc_sha256: docHash, consent: CONSENT, signed_at_client: new Date().toISOString(),
      fields: mine.map((f) => ({ id: f.spec.id, text: isImage(f.spec.kind) ? null : f.text, image: f.image })),
    };
    const sealed = await encrypt(utf8.encode(JSON.stringify(payload)), `result:${envelopeId}:${signerId}`);
    const done = await api({ action: "submit", consent: true, doc_hash: docHash, result: toB64(sealed) });
    showSigned(done.signed_at, null, !!rosterUrl);
  } catch (e) {
    const code = e instanceof Problem ? e.code : "server_error";
    if (code === "network" || code === "server_error") {
      // 입력을 잃지 않고 다시 시도할 수 있게 둔다
      button.disabled = false; button.textContent = "서명 완료";
      alert("보내지 못했어요. 입력은 그대로 있으니 연결을 확인하고 다시 눌러 주세요.");
    } else showProblem(code);
  }
});

function showSigned(at, finalUrl, offerNext = false) {
  $("top").hidden = true;
  const when = at ? new Date(at).toLocaleString("ko-KR") : "";
  const box = notice("check", "서명을 마쳤어요", finalUrl
    ? "모든 서명이 끝났어요. 완성본을 내려받아 보관하세요."
    : `${when}에 기록됐어요. 모든 서명이 끝나면 이 링크에서 완성본을 받을 수 있어요.`);
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
    const c = document.createElement("code");
    c.textContent = `SHA-256 ${hash}`;
    button.after(c);
  } catch (e) {
    alert("내려받지 못했어요. 페이지를 다시 열어 주세요.");
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
    notice("stop", "서명을 거절했어요", "보낸 사람의 앱에 표시돼요.");
    $("top").hidden = true;
  } catch (e) { showProblem(e instanceof Problem ? e.code : "server_error"); }
});

start();
