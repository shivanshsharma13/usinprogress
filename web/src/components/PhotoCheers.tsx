// Photo cheers (Settings → Motivation & focus). Snap a selfie with the front camera, add a frame and a line,
// and send it to a friend. On their timer it drifts around the ring for 3 minutes, then pins to the corner
// for the rest of the session. Not studying? It waits in an envelope on Home. Photos are deleted after a day.
import { useEffect, useRef, useState } from 'react';
import { focusedMs } from '@shared/timer';
import type { ActiveSession, PhotoCheer, PublicUser } from '@shared/types';
import { api } from '../lib/api';
import { useFocusSettings } from '../lib/focusSettings';
import { usePref } from '../lib/prefs';
import { useAction, useFriends, usePhotos } from '../lib/queries';
import { personVars } from '../lib/theme';
import { Avatar, Modal, relativeTime, useNow } from './ui';
import { XIcon } from './icons';

type Who = Pick<PublicUser, 'id' | 'displayName'> & Partial<Pick<PublicUser, 'accent' | 'avatar'>>;

const SIZE = 480; // photos are square, 480px, about 30–60 KB as JPEG
const FLOAT_MS = 3 * 60_000;
const QUICK = ['You’ve got this 💪', 'Water break? 💧', 'Proud of you 🌼', 'Studying with you 📚', 'Almost there ✨'];
const FRAMES = [
  { key: 'none', label: 'Plain' },
  { key: 'leaves', label: '🌿 Leaf crown' },
  { key: 'coffee', label: '☕ Coffee' },
  { key: 'hearts', label: '💗 Hearts' },
  { key: 'sparkle', label: '✨ Sparkle' },
] as const;
type Frame = (typeof FRAMES)[number]['key'];

// ───────────── Drawing ─────────────

function emoji(ctx: CanvasRenderingContext2D, ch: string, x: number, y: number, size: number, rotate = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotate);
  ctx.font = `${size}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ch, 0, 0);
  ctx.restore();
}

/** Frames are drawn into the photo itself, so the receiver sees exactly what you saw. */
function drawFrame(ctx: CanvasRenderingContext2D, frame: Frame) {
  const s = SIZE;
  if (frame === 'leaves') {
    const crown = ['🌿', '🌸', '🌿', '🌼', '🌿', '🌸', '🌿'];
    crown.forEach((ch, i) => {
      const t = i / (crown.length - 1); // along a gentle arc over the head
      const x = s * (0.14 + 0.72 * t);
      const y = s * (0.13 - 0.07 * Math.sin(Math.PI * t));
      emoji(ctx, ch, x, y, s * 0.11, (t - 0.5) * 0.9);
    });
  } else if (frame === 'coffee') {
    emoji(ctx, '☕', s * 0.84, s * 0.84, s * 0.2);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = s * 0.012;
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const x = s * (0.79 + i * 0.045);
      ctx.beginPath();
      ctx.moveTo(x, s * 0.72);
      ctx.bezierCurveTo(x - s * 0.03, s * 0.67, x + s * 0.03, s * 0.63, x, s * 0.58);
      ctx.stroke();
    }
    ctx.restore();
  } else if (frame === 'hearts') {
    [
      [0.1, 0.1, 0.1, -0.3],
      [0.9, 0.12, 0.08, 0.3],
      [0.08, 0.88, 0.08, 0.2],
      [0.88, 0.86, 0.12, -0.2],
      [0.22, 0.06, 0.05, 0.1],
    ].forEach(([x, y, size, r]) => emoji(ctx, '💗', s * x, s * y, s * size, r));
  } else if (frame === 'sparkle') {
    [
      [0.12, 0.14, 0.09],
      [0.86, 0.1, 0.07],
      [0.9, 0.5, 0.05],
      [0.1, 0.62, 0.05],
      [0.82, 0.86, 0.09],
      [0.2, 0.9, 0.06],
    ].forEach(([x, y, size]) => emoji(ctx, '✨', s * x, s * y, s * size));
  }
}

/** The middle square of a video frame or picture, optionally mirrored like a selfie preview. */
function drawSquare(ctx: CanvasRenderingContext2D, src: CanvasImageSource, w: number, h: number, mirror: boolean) {
  const side = Math.min(w, h);
  ctx.save();
  if (mirror) {
    ctx.translate(SIZE, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(src, (w - side) / 2, (h - side) / 2, side, side, 0, 0, SIZE, SIZE);
  ctx.restore();
}

function toJpeg(canvas: HTMLCanvasElement): string {
  for (const q of [0.78, 0.65, 0.5, 0.38]) {
    const url = canvas.toDataURL('image/jpeg', q);
    if (url.length <= 190_000) return url;
  }
  return canvas.toDataURL('image/jpeg', 0.25);
}

// ───────────── Sending ─────────────

/** "📸 Photo" next to the encouragement buttons. Hidden while Photo cheers is off. */
export function SendPhotoButton({ to, className = 'reaction-btn', label = '📸 Photo' }: { to: Who; className?: string; label?: string }) {
  const [on] = usePref('photoCheers');
  const [open, setOpen] = useState(false);
  if (!on) return null;
  return (
    <>
      <button className={className} onClick={() => setOpen(true)} aria-label={`Send a photo to ${to.displayName}`}>
        {label}
      </button>
      {open && <PhotoCamera choices={[to]} onClose={() => setOpen(false)} />}
    </>
  );
}

/** On your own timer: send to the friend you're studying with, or pick one. */
export function TimerPhotoButton({ partnerId }: { partnerId?: string | null }) {
  const [on] = usePref('photoCheers');
  const { data } = useFriends();
  const [open, setOpen] = useState(false);
  const friends = (data?.friends ?? []).map((f) => f.user);
  if (!on || !friends.length) return null;
  // Studying together? Your partner comes first; then whoever is studying right now.
  const rank = (u: PublicUser) => (u.id === partnerId ? 2 : data?.friends.find((f) => f.user.id === u.id)?.status.state === 'studying' ? 1 : 0);
  const partnerFirst = [...friends].sort((a, b) => rank(b) - rank(a));
  return (
    <>
      <button className="btn ghost small" onClick={() => setOpen(true)}>
        📸 Send a photo cheer
      </button>
      {open && <PhotoCamera choices={partnerFirst} onClose={() => setOpen(false)} />}
    </>
  );
}

export function PhotoCamera({ choices, replyTo, onClose }: { choices: Who[]; replyTo?: string; onClose: () => void }) {
  const [to, setTo] = useState(choices[0]);
  const [phase, setPhase] = useState<'starting' | 'live' | 'shot' | 'nocamera'>('starting');
  const [frame, setFrame] = useState<Frame>('none');
  const [caption, setCaption] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const raw = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const preview = useRef<HTMLCanvasElement>(null);
  const file = useRef<HTMLInputElement>(null);

  const stop = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };
  const start = async () => {
    setPhase('starting');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('no camera');
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 960 } }, audio: false });
      stream.current = s;
      if (video.current) {
        video.current.srcObject = s;
        await video.current.play().catch(() => {});
      }
      setPhase('live');
    } catch {
      setPhase('nocamera');
    }
  };
  useEffect(() => {
    void start();
    return stop;
  }, []);

  const keep = (src: CanvasImageSource, w: number, h: number, mirror: boolean) => {
    raw.current.width = raw.current.height = SIZE;
    drawSquare(raw.current.getContext('2d')!, src, w, h, mirror);
    stop(); // the camera is off as soon as the photo is taken
    setPhase('shot');
  };
  const shoot = () => {
    const v = video.current;
    if (v?.videoWidth) keep(v, v.videoWidth, v.videoHeight, true);
  };
  const pickFile = async (f: File | undefined) => {
    if (!f) return;
    const img = await createImageBitmap(f).catch(() => null);
    if (img) keep(img, img.width, img.height, false);
  };

  // Redraw the preview with the chosen frame.
  useEffect(() => {
    const c = preview.current;
    if (phase !== 'shot' || !c) return;
    c.width = c.height = SIZE;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(raw.current, 0, 0);
    drawFrame(ctx, frame);
  }, [phase, frame]);

  const send = useAction(() => api.post('/photos', { to: to.id, image: toJpeg(preview.current!), caption: caption.trim() || undefined, replyTo }), {
    invalidate: [['photos']],
    success: `Sent to ${to.displayName} 📸`,
    onSuccess: onClose,
  });

  return (
    <Modal title={replyTo ? `📸 Snap back to ${to.displayName}` : '📸 Photo cheer'} onClose={onClose}>
      <div className="stack photo-camera">
        {choices.length > 1 && (
          <div className="row wrap" style={{ gap: 6 }} role="group" aria-label="Send to">
            {choices.map((c) => (
              <button key={c.id} className={`chip-btn${to.id === c.id ? ' on' : ''}`} aria-pressed={to.id === c.id} onClick={() => setTo(c)}>
                {c.displayName}
              </button>
            ))}
          </div>
        )}

        <div className="photo-stage">
          <video ref={video} className="photo-live" playsInline muted hidden={phase !== 'live' && phase !== 'starting'} />
          {phase === 'shot' && <canvas ref={preview} className="photo-preview" aria-label="Your photo" />}
          {phase === 'starting' && <span className="photo-hint small muted">Opening the camera…</span>}
          {phase === 'nocamera' && (
            <div className="photo-hint stack" style={{ alignItems: 'center', textAlign: 'center' }}>
              <span className="small">The camera isn't available here.</span>
              <button className="btn primary" onClick={() => file.current?.click()}>
                Take or choose a photo
              </button>
            </div>
          )}
          <input ref={file} type="file" accept="image/*" capture="user" hidden onChange={(e) => void pickFile(e.target.files?.[0])} />
        </div>

        {phase === 'live' && (
          <button className="shutter" onClick={shoot} aria-label="Take the photo">
            <span />
          </button>
        )}

        {phase === 'shot' && (
          <>
            <div className="row wrap" style={{ gap: 6 }} role="group" aria-label="Frame">
              {FRAMES.map((f) => (
                <button key={f.key} className={`chip-btn${frame === f.key ? ' on' : ''}`} aria-pressed={frame === f.key} onClick={() => setFrame(f.key)}>
                  {f.label}
                </button>
              ))}
            </div>
            <input className="input" value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={80} placeholder="Add a line (optional)" aria-label="Caption" />
            <div className="row wrap" style={{ gap: 6 }}>
              {QUICK.map((q) => (
                <button key={q} className={`chip-btn small${caption === q ? ' on' : ''}`} onClick={() => setCaption(caption === q ? '' : q)}>
                  {q}
                </button>
              ))}
            </div>
            <div className="row between">
              <button className="btn ghost" onClick={() => void start()} disabled={send.isPending}>
                Retake
              </button>
              <button className="btn primary" onClick={() => send.mutate(undefined)} disabled={send.isPending}>
                Send to {to.displayName}
              </button>
            </div>
          </>
        )}
        <p className="tiny muted" style={{ margin: 0 }}>
          Only {to.displayName} can see it, and it's deleted after 24 hours.
        </p>
      </div>
    </Modal>
  );
}

// ───────────── Receiving ─────────────

const shownHere = new Map<string, number>(); // photo id → when it first appeared on this device
const markedSeen = new Set<string>();

/** Photos on your timer: new ones drift around the ring for 3 minutes, then pin to the corner. */
export function TimerPhotos({ session, meId }: { session: ActiveSession; meId: string }) {
  const [on] = usePref('photoCheers');
  const { data: photos } = usePhotos(on);
  const { data: friends } = useFriends();
  const { floatPhotos } = useFocusSettings();
  const now = useNow(1000);
  const [open, setOpen] = useState<PhotoCheer | null>(null);
  const calm = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const mine = (photos ?? []).filter((p) => p.recipientId === meId && (p.seenAt === null || p.seenAt >= session.startedAt || shownHere.has(p.id)));
  useEffect(() => {
    for (const p of mine) {
      if (!shownHere.has(p.id)) shownHere.set(p.id, p.seenAt ?? Date.now());
      if (p.seenAt === null && !markedSeen.has(p.id)) {
        markedSeen.add(p.id);
        void api.post(`/photos/${p.id}/seen`).catch(() => markedSeen.delete(p.id));
      }
    }
  });
  if (!on || !mine.length) return null;

  const sender = (id: string) => friends?.friends.find((f) => f.user.id === id)?.user;
  const floating = mine.filter((p) => floatPhotos && !calm && now - (shownHere.get(p.id) ?? now) < FLOAT_MS);
  const pinned = mine.filter((p) => !floating.includes(p)).slice(0, 4);

  return (
    <>
      {floating.map((p, i) => (
        <div key={p.id} className="photo-orbit" style={{ animationDelay: `${-i * 9}s` }}>
          <button className="polaroid floating" onClick={() => setOpen(p)} aria-label={`Photo from ${sender(p.senderId)?.displayName ?? 'your friend'}`}>
            <img src={p.image} alt="" />
          </button>
        </div>
      ))}
      {pinned.length > 0 && (
        <div className="photo-pins">
          {pinned.map((p, i) => (
            <button key={p.id} className="polaroid pinned" style={{ rotate: `${(i % 2 ? 1 : -1) * (4 + i * 2)}deg` }} onClick={() => setOpen(p)} aria-label={`Photo from ${sender(p.senderId)?.displayName ?? 'your friend'}`}>
              <img src={p.image} alt="" />
            </button>
          ))}
        </div>
      )}
      {open && <PhotoViewer photo={open} sender={sender(open.senderId)} onClose={() => setOpen(null)} />}
    </>
  );
}

/** A photo, big: the line they wrote, a heart back, and a snap back. */
export function PhotoViewer({ photo, sender, onClose }: { photo: PhotoCheer; sender: PublicUser | undefined; onClose: () => void }) {
  const [snapBack, setSnapBack] = useState(false);
  const [hearted, setHearted] = useState(Boolean(photo.heartedAt));
  const name = sender?.displayName ?? 'Your friend';
  const heart = useAction(() => api.post(`/photos/${photo.id}/heart`), { invalidate: [['photos']], success: `💗 Sent to ${name}`, onSuccess: () => setHearted(true) });
  useEffect(() => {
    if (photo.seenAt === null && !markedSeen.has(photo.id)) {
      markedSeen.add(photo.id);
      void api.post(`/photos/${photo.id}/seen`);
    }
  }, [photo]);

  if (snapBack && sender) return <PhotoCamera choices={[sender]} replyTo={photo.id} onClose={onClose} />;
  return (
    <Modal title={`From ${name}`} onClose={onClose}>
      <div className="stack" style={sender ? personVars(sender.accent) : undefined}>
        <figure className="polaroid big">
          <img src={photo.image} alt={`Photo from ${name}`} />
          {photo.caption && <figcaption>{photo.caption}</figcaption>}
        </figure>
        <p className="tiny muted" style={{ margin: 0, textAlign: 'center' }}>
          {photo.replyTo ? '↩ A snap back to your photo · ' : ''}
          {relativeTime(photo.createdAt)}
        </p>
        <div className="row" style={{ justifyContent: 'center' }}>
          <button className="btn" disabled={hearted || heart.isPending} onClick={() => heart.mutate(undefined)}>
            {hearted ? '💗 Loved' : '💗 Heart back'}
          </button>
          {sender && (
            <button className="btn primary" onClick={() => setSnapBack(true)}>
              📸 Snap back
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** On Home, while you're not studying: "Mira sent you a photo". Opening it counts as seeing it. */
export function PhotoEnvelope({ meId }: { meId: string }) {
  const [on] = usePref('photoCheers');
  const { data: photos } = usePhotos(on);
  const { data: friends } = useFriends();
  const [open, setOpen] = useState<PhotoCheer | null>(null);
  const waiting = (photos ?? []).filter((p) => p.recipientId === meId && p.seenAt === null && !markedSeen.has(p.id));
  if (!on) return null;
  const first = waiting[waiting.length - 1]; // oldest first
  const sender = (id: string) => friends?.friends.find((f) => f.user.id === id)?.user;
  const who = first && sender(first.senderId);
  return (
    <>
      {first && (
        <button className="card photo-envelope" onClick={() => setOpen(first)} style={who ? personVars(who.accent) : undefined}>
          <span className="envelope" aria-hidden="true">
            💌
          </span>
          <span className="grow" style={{ textAlign: 'left' }}>
            <b>
              {who?.displayName ?? 'Your friend'} sent you {waiting.length > 1 ? `${waiting.length} photos` : 'a photo'}
            </b>
            <span className="tiny muted" style={{ display: 'block' }}>
              Tap to open, or start studying and {waiting.length > 1 ? 'they' : 'it'}'ll float onto your timer.
            </span>
          </span>
          {who && <Avatar user={who} size={36} />}
        </button>
      )}
      {open && <PhotoViewer photo={open} sender={sender(open.senderId)} onClose={() => setOpen(null)} />}
    </>
  );
}

const NUDGED = 'us-in-progress-photo-nudged';
const HOUR = 3_600_000;

/** "Mira just hit 1 hour of focus — send a cheer?" Once per friend per session, for 20 minutes. */
export function PhotoNudge() {
  const [on] = usePref('photoCheers');
  const { data } = useFriends();
  const now = useNow(30_000);
  const [done, setDone] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(NUDGED) ?? '[]');
    } catch {
      return [];
    }
  });
  const [camera, setCamera] = useState<PublicUser | null>(null);
  if (!on) return null;
  const f = data?.friends.find((x) => {
    const s = x.status;
    if ((s.state !== 'studying' && s.state !== 'paused') || !s.startedAt || done.includes(`${x.user.id}:${s.startedAt}`)) return false;
    const ms = focusedMs({ startedAt: s.startedAt, endedAt: null, pauses: s.pauses ?? [] }, now);
    return ms >= HOUR && ms < HOUR + 20 * 60_000;
  });
  const dismiss = (key: string) => {
    const next = [...done, key].slice(-30);
    setDone(next);
    try {
      localStorage.setItem(NUDGED, JSON.stringify(next));
    } catch {}
  };
  if (camera) return <PhotoCamera choices={[camera]} onClose={() => setCamera(null)} />;
  if (!f) return null;
  const key = `${f.user.id}:${f.status.startedAt}`;
  return (
    <div className="together-nudge" role="status" style={personVars(f.user.accent)}>
      <Avatar user={f.user} size={36} />
      <span className="grow small">
        <b>{f.user.displayName}</b> just hit 1 hour of focus ⏰ Send a photo cheer?
      </span>
      <button
        className="btn primary small"
        onClick={() => {
          dismiss(key);
          setCamera(f.user);
        }}
      >
        📸 Send
      </button>
      <button className="btn ghost icon small" onClick={() => dismiss(key)} aria-label="Not now">
        <XIcon width={16} />
      </button>
    </div>
  );
}
