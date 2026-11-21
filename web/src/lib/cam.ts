// Study cam (Settings → Motivation & focus): a video call with a friend that stays quiet while you focus.
// Video and sound go straight between the two devices (WebRTC). The setup messages ("calling", the offer and
// answer, network details) travel through the database (cam_signals) and arrive over Realtime.
//
// One call at a time, kept here outside React so it carries on while you move between screens.
// While you're focusing, your mic is off and your friend's sound is muted on your side; you only see each other.
import { useSyncExternalStore } from 'react';
import { supabase } from './supabase';
import { api } from './api';

export type CallPhase = 'idle' | 'calling' | 'incoming' | 'connecting' | 'live';

export interface CallState {
  phase: CallPhase;
  peerId: string | null;
  callId: string | null;
  local: MediaStream | null;
  remote: MediaStream | null;
  camOff: boolean; // you switched your camera off
  micOff: boolean; // you muted yourself (on top of focus muting)
  focusing: boolean; // your timer is running: mic off, their sound muted
  ended: string | null; // why the last call ended, shown for a moment
}

type Signal = { from_user: string; to_user: string; call_id: string; kind: string; payload: Record<string, any> };

const RING_MS = 45_000;
const CONNECT_MS = 30_000;
const LOST_MS = 15_000;

function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  // A relay for networks that can't connect directly (common on mobile data). Optional; set at build time.
  const turn = import.meta.env.VITE_TURN_URLS as string | undefined;
  if (turn)
    servers.push({ urls: turn.split(',').map((u) => u.trim()), username: import.meta.env.VITE_TURN_USERNAME as string, credential: import.meta.env.VITE_TURN_CREDENTIAL as string });
  return servers;
}

const IDLE: CallState = { phase: 'idle', peerId: null, callId: null, local: null, remote: null, camOff: false, micOff: false, focusing: false, ended: null };

let state: CallState = IDLE;
const listeners = new Set<() => void>();
function set(patch: Partial<CallState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

let meId: string | null = null;
let channel: ReturnType<typeof supabase.channel> | null = null;
let pc: RTCPeerConnection | null = null;
let pendingIce: RTCIceCandidateInit[] = [];
let ringTimer: ReturnType<typeof setTimeout> | null = null;
let lostTimer: ReturnType<typeof setTimeout> | null = null;
let endedTimer: ReturnType<typeof setTimeout> | null = null;

const send = (kind: string, payload: Record<string, unknown> = {}, to = state.peerId, callId = state.callId) =>
  to && callId ? api.post('/cam/signal', { to, callId, kind, payload }) : Promise.resolve();

/** Mic and camera follow focus, your own switches, and whether the app is on screen. */
function applyTracks() {
  const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
  for (const t of state.local?.getAudioTracks() ?? []) t.enabled = !state.focusing && !state.micOff;
  for (const t of state.local?.getVideoTracks() ?? []) t.enabled = !state.camOff && visible;
}

async function openMedia(): Promise<MediaStream> {
  const video = { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 15 } };
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio });
  } catch {
    return navigator.mediaDevices.getUserMedia({ audio }); // no camera: still talk
  }
}

/** Answered, now waiting for the two devices to find each other. */
function connecting() {
  if (ringTimer) clearTimeout(ringTimer);
  set({ phase: 'connecting' });
  ringTimer = setTimeout(() => {
    if (state.phase !== 'connecting') return;
    void send('hangup').catch(() => {});
    cleanup("Couldn't connect. Try both on Wi-Fi?");
  }, CONNECT_MS);
}

function cleanup(reason: string | null) {
  if (ringTimer) clearTimeout(ringTimer);
  if (lostTimer) clearTimeout(lostTimer);
  ringTimer = lostTimer = null;
  pc?.close();
  pc = null;
  pendingIce = [];
  state.local?.getTracks().forEach((t) => t.stop());
  set({ ...IDLE, focusing: state.focusing, ended: reason });
  if (endedTimer) clearTimeout(endedTimer);
  if (reason) endedTimer = setTimeout(() => set({ ended: null }), 4000);
}

function makePeer(stream: MediaStream) {
  const peer = new RTCPeerConnection({ iceServers: iceServers() });
  for (const track of stream.getTracks()) {
    const sender = peer.addTrack(track, stream);
    if (track.kind === 'video') {
      // Small and light: this is company, not a meeting. Keeps mobile data and battery low.
      const params = sender.getParameters();
      params.encodings = [{ ...(params.encodings?.[0] ?? {}), maxBitrate: 250_000 }];
      void sender.setParameters(params).catch(() => {});
    }
  }
  peer.onicecandidate = (e) => {
    if (e.candidate) void send('ice', { candidate: e.candidate.toJSON() }).catch(() => {});
  };
  peer.ontrack = (e) => set({ remote: e.streams[0] ?? new MediaStream([e.track]) });
  peer.onconnectionstatechange = () => {
    if (peer !== pc) return;
    const s = peer.connectionState;
    if (s === 'connected') {
      if (lostTimer) clearTimeout(lostTimer);
      if (ringTimer) clearTimeout(ringTimer);
      lostTimer = ringTimer = null;
      set({ phase: 'live' });
    } else if (s === 'disconnected') {
      lostTimer ??= setTimeout(() => cleanup('The call dropped'), LOST_MS);
    } else if (s === 'failed') {
      void send('hangup').catch(() => {});
      cleanup("Couldn't connect. Try both on Wi-Fi?");
    }
  };
  pc = peer;
  return peer;
}

async function addIce(c: RTCIceCandidateInit) {
  if (pc?.remoteDescription) await pc.addIceCandidate(c).catch(() => {});
  else pendingIce.push(c);
}
async function flushIce() {
  for (const c of pendingIce.splice(0)) await pc?.addIceCandidate(c).catch(() => {});
}

async function onSignal(s: Signal) {
  if (s.to_user !== meId) return;
  const same = s.call_id === state.callId && s.from_user === state.peerId;
  switch (s.kind) {
    case 'ring':
      if (state.phase === 'idle') {
        set({ phase: 'incoming', peerId: s.from_user, callId: s.call_id, ended: null });
        ringTimer = setTimeout(() => state.phase === 'incoming' && cleanup(null), RING_MS);
      } else if (state.phase === 'calling' && state.peerId === s.from_user) {
        // You both called at once: the lower call id wins, and the other side answers it.
        if (s.call_id < state.callId!) {
          set({ callId: s.call_id });
          connecting();
          void send('accept');
        }
      } else if (!same) {
        void send('busy', {}, s.from_user, s.call_id).catch(() => {});
      }
      return;
    case 'accept':
      if (same && state.phase === 'calling' && state.local) {
        connecting();
        const peer = makePeer(state.local);
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await send('offer', { sdp: offer.sdp, type: offer.type });
      }
      return;
    case 'offer':
      if (same && state.local) {
        const peer = pc ?? makePeer(state.local);
        await peer.setRemoteDescription({ type: 'offer', sdp: s.payload.sdp });
        await flushIce();
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        await send('answer', { sdp: answer.sdp, type: answer.type });
      }
      return;
    case 'answer':
      if (same && pc && !pc.currentRemoteDescription) {
        await pc.setRemoteDescription({ type: 'answer', sdp: s.payload.sdp });
        await flushIce();
      }
      return;
    case 'ice':
      if (same && s.payload.candidate) await addIce(s.payload.candidate);
      return;
    case 'decline':
      if (same) cleanup('Not right now — they declined');
      return;
    case 'busy':
      if (same) cleanup("They're on another call");
      return;
    case 'hangup':
      if (same) cleanup(state.phase === 'incoming' ? 'Missed call' : 'Call ended');
      return;
  }
}

function onVisibility() {
  applyTracks();
}
function onLeave() {
  // Closing the app: tell your friend straight away instead of letting the call drop after a while.
  if (state.phase !== 'idle' && state.phase !== 'incoming') void send('hangup').catch(() => {});
}

/** Start listening for calls (while Study cam is on). Returns a stop function. */
export function startCam(userId: string): () => void {
  meId = userId;
  channel = supabase
    .channel(`cam-${userId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'cam_signals', filter: `to_user=eq.${userId}` }, (p) => {
      void onSignal(p.new as Signal).catch(() => {});
    })
    .subscribe();
  document.addEventListener('visibilitychange', onVisibility);
  addEventListener('pagehide', onLeave);
  return () => {
    if (state.phase !== 'idle') {
      void send('hangup').catch(() => {});
      cleanup(null);
    }
    document.removeEventListener('visibilitychange', onVisibility);
    removeEventListener('pagehide', onLeave);
    if (channel) void supabase.removeChannel(channel);
    channel = null;
    meId = null;
  };
}

export async function call(friendId: string) {
  if (state.phase !== 'idle') return;
  const callId = crypto.randomUUID();
  set({ phase: 'calling', peerId: friendId, callId, ended: null, camOff: false, micOff: false });
  try {
    const local = await openMedia();
    if (state.callId !== callId) return local.getTracks().forEach((t) => t.stop());
    set({ local });
    applyTracks();
    await send('ring');
    ringTimer = setTimeout(() => {
      if (state.phase === 'calling') {
        void send('hangup').catch(() => {});
        cleanup('No answer');
      }
    }, RING_MS);
  } catch (e) {
    cleanup(e instanceof Error && e.name === 'NotAllowedError' ? 'Allow the camera and mic to call' : e instanceof Error ? e.message : "Couldn't start the call");
  }
}

export async function accept() {
  if (state.phase !== 'incoming') return;
  connecting();
  try {
    const local = await openMedia();
    set({ local });
    applyTracks();
    await send('accept');
  } catch (e) {
    void send('decline').catch(() => {});
    cleanup(e instanceof Error && e.name === 'NotAllowedError' ? 'Allow the camera and mic to join' : "Couldn't join the call");
  }
}

export function decline() {
  if (state.phase !== 'incoming') return;
  void send('decline').catch(() => {});
  cleanup(null);
}

export function hangUp() {
  if (state.phase === 'idle') return;
  void send('hangup').catch(() => {});
  cleanup('Call ended');
}

export function setCamOff(off: boolean) {
  set({ camOff: off });
  applyTracks();
}
export function setMicOff(off: boolean) {
  set({ micOff: off });
  applyTracks();
}
export function setFocusing(focusing: boolean) {
  if (state.focusing === focusing) return;
  set({ focusing });
  applyTracks();
}

export function useCall(): CallState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
