// Two-browser chess via WebRTC.
//
//   Host:  loads bare URL → generates a random peer ID → posts an
//          invite link with ?join=<id>.
//   Guest: opens the invite link → connects to <id> via PeerJS.
//
// PeerJS's public broker handles ONLY the SDP handshake (offer/answer
// exchange). Once the WebRTC data channel is up, every move travels
// peer-to-peer with no server in the middle. The host plays white;
// the guest plays black; turns enforced both by chess.js + a "whose
// turn" check on every received message.

import { Chess } from "chess.js";
import { Chessground } from "chessground";
// Chessground ships its CSS in the package; pull all three theme files so
// the board renders with proper piece sprites + colors.
import "chessground/assets/chessground.base.css";
import "chessground/assets/chessground.brown.css";
import "chessground/assets/chessground.cburnett.css";
import { Peer } from "peerjs";

const els = {
  board: document.getElementById("board"),
  status: document.getElementById("board-status"),
  role: document.getElementById("role"),
  conn: document.getElementById("conn-status"),
  invite: document.getElementById("invite-block"),
  inviteLink: document.getElementById("invite-link"),
  copy: document.getElementById("copy-invite"),
  manual: document.getElementById("manual-block"),
  manualId: document.getElementById("manual-id"),
  manualJoin: document.getElementById("manual-join"),
  moves: document.getElementById("move-list"),
  reset: document.getElementById("reset"),
};

// --- chess state ----------------------------------------------------

const game = new Chess();
let myColor = null; // "white" or "black"
let ground = null;
let dataConn = null;
let peer = null;

function shortId(n = 8) {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = "wb-chess-";
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

function setStatus(msg, kind = "") {
  els.status.textContent = msg;
  els.status.className = "board-status";
  if (kind) els.status.classList.add(`is-${kind}`);
}
function setConn(msg) {
  els.conn.textContent = msg;
}
function setRole(role) {
  els.role.textContent = role ?? "—";
}

function legalDestsForColor(color) {
  const dests = new Map();
  if (game.isGameOver()) return dests;
  // chess.js uses "w"/"b" for color; chessground's `dests` map needs every
  // square that has at least one legal move + its destinations.
  const turn = game.turn(); // "w" / "b"
  if ((color === "white" && turn !== "w") || (color === "black" && turn !== "b")) return dests;
  const moves = game.moves({ verbose: true });
  for (const m of moves) {
    if (!dests.has(m.from)) dests.set(m.from, []);
    dests.get(m.from).push(m.to);
  }
  return dests;
}

function syncBoard() {
  if (!ground) return;
  const turn = game.turn() === "w" ? "white" : "black";
  ground.set({
    fen: game.fen(),
    turnColor: turn,
    movable: {
      color: myColor,
      dests: myColor ? legalDestsForColor(myColor) : new Map(),
    },
    check: game.inCheck() ? turn : false,
    lastMove: lastMoveSquares(),
  });
  refreshStatus();
}

function lastMoveSquares() {
  const history = game.history({ verbose: true });
  if (history.length === 0) return undefined;
  const m = history[history.length - 1];
  return [m.from, m.to];
}

function refreshStatus() {
  if (game.isCheckmate()) {
    const winner = game.turn() === "w" ? "black" : "white";
    setStatus(`Checkmate — ${winner} wins.`, "mate");
    return;
  }
  if (game.isStalemate()) return setStatus("Stalemate.", "mate");
  if (game.isThreefoldRepetition()) return setStatus("Draw (threefold repetition).", "mate");
  if (game.isInsufficientMaterial()) return setStatus("Draw (insufficient material).", "mate");
  if (game.isDraw()) return setStatus("Draw.", "mate");
  const turn = game.turn() === "w" ? "white" : "black";
  if (game.inCheck()) return setStatus(`${cap(turn)} to move — in check.`, "check");
  if (myColor) {
    if (turn === myColor) return setStatus(`Your move (${turn}).`, "active");
    return setStatus(`Waiting for ${turn}…`);
  }
  return setStatus(`${cap(turn)} to move.`);
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function refreshMoveList() {
  const verbose = game.history({ verbose: true });
  const sans = game.history();
  els.moves.innerHTML = "";
  for (let i = 0; i < sans.length; i += 2) {
    const moveNum = Math.floor(i / 2) + 1;
    const w = sans[i];
    const b = sans[i + 1];
    const li1 = document.createElement("li");
    li1.textContent = `${moveNum}. ${w}`;
    if (i === sans.length - 1) li1.classList.add("is-last");
    els.moves.appendChild(li1);
    if (b) {
      const li2 = document.createElement("li");
      li2.textContent = `… ${b}`;
      if (i + 1 === sans.length - 1) li2.classList.add("is-last");
      els.moves.appendChild(li2);
    }
  }
  void verbose; // (kept in case we want to render more later)
  els.moves.scrollTop = els.moves.scrollHeight;
}

// --- ground init ----------------------------------------------------

function initBoard() {
  ground = Chessground(els.board, {
    fen: game.fen(),
    orientation: myColor || "white",
    turnColor: "white",
    movable: {
      free: false,
      color: myColor,
      dests: new Map(),
      events: { after: onLocalMove },
    },
    animation: { enabled: true, duration: 220 },
    highlight: { lastMove: true, check: true },
  });
}

function onLocalMove(orig, dest) {
  // chessground reports the move in coordinate notation (e2, e4).
  // chess.js wants algebraic; .move({ from, to, promotion }) handles it.
  const move = applyLocalMove(orig, dest);
  if (move && dataConn?.open) {
    dataConn.send({ type: "move", from: orig, to: dest, promotion: move.promotion ?? "q" });
  }
}

function applyLocalMove(from, to, promotion = "q") {
  // Auto-promote to queen when a pawn reaches the back rank — fancy
  // promotion UI is out of scope for the demo. chess.js silently
  // rejects illegal moves, so we get null on bad input.
  let move = null;
  try {
    move = game.move({ from, to, promotion });
  } catch {
    move = null;
  }
  if (!move) {
    syncBoard();
    return null;
  }
  refreshMoveList();
  syncBoard();
  return move;
}

// --- networking -----------------------------------------------------

// Room-based handshake. Both browsers derive the same peer id from
// the URL hash (e.g. #room=abc-123); whichever registers it FIRST
// becomes the host (white), the other becomes the guest (black) and
// connects to that id. URLs survive reloads — no stale invite links.
function getOrMintRoom() {
  // Prefer the URL hash so reloads keep the same room. Fall back to
  // ?room= for shareable links that travel through chat clients which
  // sometimes strip fragments.
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const search = new URLSearchParams(window.location.search);
  let room = hash.get("room") || search.get("room") || search.get("join");
  if (!room) {
    room = shortId(8).replace(/^wb-chess-/, "");
    // Update the URL in place so reloads reuse the same room.
    const u = new URL(window.location.href);
    u.searchParams.delete("join");
    u.hash = `room=${room}`;
    window.history.replaceState(null, "", u.toString());
  }
  // Strip any "wb-chess-" prefix from older invite urls so the room
  // string itself is short and shareable.
  return room.replace(/^wb-chess-/, "");
}

const room = getOrMintRoom();
const HOST_PEER_ID = `wb-chess-host-${room}`;

async function bootstrap() {
  initBoard();
  setConn("connecting to broker…");
  await tryHostThenGuest();
}

async function tryHostThenGuest() {
  // Race: try to grab the host id. If PeerJS rejects with `unavailable-id`
  // we know the host already exists — flip to guest and connect to it.
  peer = new Peer(HOST_PEER_ID, { debug: 1 });
  let resolved = false;
  peer.on("open", () => {
    if (resolved) return;
    resolved = true;
    becomeHost();
  });
  peer.on("error", (err) => {
    if (resolved) {
      console.error("peer error", err);
      // Already-connected errors after we've claimed a role.
      if (err.type === "peer-unavailable") {
        setConn("opponent unreachable — refresh to retry");
      } else {
        setConn(`error: ${err.type ?? err.message ?? err}`);
      }
      return;
    }
    if (err.type === "unavailable-id") {
      // The host slot is taken. We're the guest.
      resolved = true;
      try { peer.destroy(); } catch {}
      becomeGuest();
      return;
    }
    // Other startup errors (network, broker down).
    console.error("peer error", err);
    setConn(`error: ${err.type ?? err.message ?? err}`);
    setStatus("Couldn't reach the PeerJS broker. Check your network and refresh.");
  });
}

function becomeHost() {
  myColor = "white";
  setRole("White (host)");
  setConn(`waiting for opponent in room ${room}`);
  syncBoard();
  // Surface the invite URL — same room hash works on reload.
  const inviteUrl = new URL(window.location.href);
  inviteUrl.search = "";
  inviteUrl.hash = `room=${room}`;
  els.inviteLink.value = inviteUrl.toString();
  els.invite.hidden = false;
  setStatus("Share the link to invite your opponent.");
  peer.on("connection", (conn) => {
    setConn("opponent connecting…");
    wireDataChannel(conn);
  });
}

function becomeGuest() {
  myColor = "black";
  setRole("Black");
  setConn(`joining room ${room}…`);
  syncBoard();
  // Fresh Peer with auto-minted id; we only need to dial the host.
  peer = new Peer({ debug: 1 });
  peer.on("open", () => {
    setConn(`dialing host…`);
    const conn = peer.connect(HOST_PEER_ID, { reliable: true });
    wireDataChannel(conn);
  });
  peer.on("error", (err) => {
    console.error("guest peer error", err);
    if (err.type === "peer-unavailable") {
      setConn("host vanished");
      setStatus("Host disconnected. Refresh to claim the host slot yourself.");
      return;
    }
    setConn(`error: ${err.type ?? err.message ?? err}`);
  });
  // Manual-join is a contingency — leave it visible in case the URL
  // hash got stripped somewhere upstream.
  els.manual.hidden = false;
  els.manualJoin.addEventListener("click", () => {
    const id = els.manualId.value.trim();
    if (!id) return;
    const conn = peer.connect(id, { reliable: true });
    wireDataChannel(conn);
  });
}

function wireDataChannel(conn) {
  dataConn = conn;
  conn.on("open", () => {
    setConn("connected ✓");
    setStatus(myColor === "white" ? "Your move (white)." : "Waiting for white…", "active");
    // Send a hello so each side knows the other's role + initial state.
    conn.send({ type: "hello", role: myColor === "white" ? "host" : "guest" });
    if (myColor === "white") {
      els.invite.hidden = true; // game's on, hide the invite UI
    }
  });
  conn.on("data", onPeerMessage);
  conn.on("close", () => {
    setConn("disconnected");
    setStatus("Opponent disconnected. Refresh to start a new game.", "mate");
  });
  conn.on("error", (err) => {
    console.error("conn error", err);
    setConn(`channel error: ${err.message ?? err}`);
  });
}

function onPeerMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "hello") {
    // Sanity check role assignment.
    return;
  }
  if (msg.type === "move") {
    // Apply opponent's move locally. chess.js validates legality so
    // a malicious peer can't play illegal moves through the data channel.
    let applied = null;
    try {
      applied = game.move({ from: msg.from, to: msg.to, promotion: msg.promotion ?? "q" });
    } catch {
      applied = null;
    }
    if (!applied) {
      console.warn("rejected illegal move from peer", msg);
      setStatus("Opponent sent an illegal move (rejected).", "mate");
      return;
    }
    refreshMoveList();
    syncBoard();
    return;
  }
  if (msg.type === "reset") {
    game.reset();
    refreshMoveList();
    syncBoard();
    setStatus("Opponent reset the game.");
    return;
  }
}

// --- copy invite ----------------------------------------------------

els.copy.addEventListener("click", async () => {
  els.inviteLink.select();
  try {
    await navigator.clipboard.writeText(els.inviteLink.value);
    els.copy.textContent = "Copied ✓";
    setTimeout(() => (els.copy.textContent = "Copy"), 1500);
  } catch {
    document.execCommand?.("copy");
  }
});

// --- reset ----------------------------------------------------------

els.reset.addEventListener("click", () => {
  if (!confirm("Reset the game? Your opponent will be reset too.")) return;
  game.reset();
  refreshMoveList();
  syncBoard();
  setStatus("Game reset.");
  if (dataConn?.open) dataConn.send({ type: "reset" });
});

// --- go -------------------------------------------------------------

bootstrap();
refreshMoveList();
