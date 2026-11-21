// Study cam (Settings → Motivation & focus). Call a friend to talk before you start; once either timer runs,
// that side's mic goes off and you just see each other studying; on a break you can talk again. The call
// floats over every screen, so you can move from the room to the timer without hanging up.
import { useEffect, useRef, useState } from 'react';
import type { Me, PublicUser } from '@shared/types';
import { accept, call, decline, hangUp, setCamOff, setFocusing, setMicOff, startCam, useCall } from '../lib/cam';
import { usePref } from '../lib/prefs';
import { useActiveSession, useFriends } from '../lib/queries';
import { personVars } from '../lib/theme';
import { Avatar } from './ui';

function Video({ stream, muted, className, label }: { stream: MediaStream | null; muted: boolean; className: string; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (v && v.srcObject !== stream) v.srcObject = stream;
  }, [stream]);
  useEffect(() => {
    if (ref.current) ref.current.muted = muted;
  }, [muted]);
  return <video ref={ref} className={className} autoPlay playsInline muted={muted} aria-label={label} />;
}

/** Listens for calls and shows the call wherever you are. Mounted once, in the layout. */
export function CamHost({ me }: { me: Me }) {
  const [on] = usePref('studyCam');
  const { data: session } = useActiveSession(on);
  const { data: friends } = useFriends();
  const c = useCall();
  const [big, setBig] = useState(false);

  useEffect(() => (on ? startCam(me.id) : undefined), [on, me.id]);
  // Your timer running = focus: your mic off and your friend's sound muted. Paused or on a break = talk.
  useEffect(() => setFocusing(session?.state === 'running'), [session?.state]);

  if (!on) return null;
  const peer = friends?.friends.find((f) => f.user.id === c.peerId)?.user;
  const name = peer?.displayName ?? 'Your friend';

  if (c.phase === 'idle')
    return c.ended ? (
      <div className="cam-toast" role="status">
        📹 {c.ended}
      </div>
    ) : null;

  if (c.phase === 'incoming')
    return (
      <div className="cam-ring" role="alertdialog" aria-label={`${name} is calling`} style={peer ? personVars(peer.accent) : undefined}>
        {peer && <Avatar user={peer} size={40} />}
        <span className="grow small">
          <b>{name}</b> is calling on Study cam 📹
        </span>
        <button className="btn ghost small" onClick={decline}>
          Not now
        </button>
        <button className="btn primary small" onClick={() => void accept()}>
          Join
        </button>
      </div>
    );

  const live = c.phase === 'live';
  const theirVideo = live && c.remote?.getVideoTracks().some((t) => t.readyState === 'live');
  return (
    <div className={`cam-tile${big && !c.focusing ? ' big' : ''}${c.focusing ? ' focus' : ''}`} style={peer ? personVars(peer.accent) : undefined} role="region" aria-label={`Study cam with ${name}`}>
      <button className="cam-stage" onClick={() => setBig(!big)} aria-label={big ? 'Make the call smaller' : 'Make the call bigger'} disabled={c.focusing}>
        {live ? (
          <Video stream={c.remote} muted={c.focusing} className="cam-remote" label={`${name}'s camera`} />
        ) : (
          <span className="cam-wait small">{peer && <Avatar user={peer} size={44} />}{c.phase === 'calling' ? `Calling ${name}…` : 'Connecting…'}</span>
        )}
        {live && !theirVideo && <span className="cam-wait small">{peer && <Avatar user={peer} size={44} />}Camera off</span>}
        {c.local && !c.camOff && <Video stream={c.local} muted className="cam-self" label="Your camera" />}
      </button>
      <div className="cam-bar">
        <span className="cam-mode tiny" aria-live="polite">
          {!live ? 'Ringing…' : c.focusing ? '🤫 Focus · quiet' : c.micOff ? '🔇 You muted yourself' : '🎙 Talking'}
        </span>
        {!c.focusing && (
          <button className="btn icon small" onClick={() => setMicOff(!c.micOff)} aria-pressed={c.micOff} aria-label={c.micOff ? 'Unmute' : 'Mute'}>
            {c.micOff ? '🔇' : '🎙'}
          </button>
        )}
        <button className="btn icon small" onClick={() => setCamOff(!c.camOff)} aria-pressed={c.camOff} aria-label={c.camOff ? 'Turn camera on' : 'Turn camera off'}>
          {c.camOff ? '🚫' : '📷'}
        </button>
        <button className="btn icon small danger" onClick={hangUp} aria-label="Hang up">
          ✕
        </button>
      </div>
    </div>
  );
}

/** "📹 Call" for a friend, while Study cam is on and you're not already in a call. */
export function CamCallButton({ friend, className = 'btn small', label }: { friend: Pick<PublicUser, 'id' | 'displayName'>; className?: string; label?: string }) {
  const [on] = usePref('studyCam');
  const c = useCall();
  if (!on) return null;
  const inThisCall = c.phase !== 'idle' && c.peerId === friend.id;
  return (
    <button className={className} disabled={c.phase !== 'idle'} onClick={() => void call(friend.id)} aria-label={`Study cam call with ${friend.displayName}`}>
      {inThisCall ? '📹 In a call' : (label ?? '📹 Study cam')}
    </button>
  );
}

/** Before you start the timer: call a friend to talk first. Your mic goes off by itself once you press start. */
export function CamBeforeStart() {
  const [on] = usePref('studyCam');
  const { data } = useFriends();
  const c = useCall();
  const friends = (data?.friends ?? []).map((f) => f.user);
  if (!on || !friends.length || c.phase !== 'idle') return null;
  return (
    <div className="card row wrap cam-before">
      <span className="grow small">📹 Talk before you start? Once you press start, your mic turns off and you just see each other.</span>
      {friends.slice(0, 3).map((f) => (
        <CamCallButton key={f.id} friend={f} label={`📹 Call ${f.displayName}`} />
      ))}
    </div>
  );
}
