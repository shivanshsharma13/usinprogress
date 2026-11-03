// Settings → Focus: optional sound and notification controls for the timer, saved on this device.
import { useEffect, useState } from 'react';
import { FOCUS_SOUNDS, setFocusSettings, useFocusSettings, type FocusSound } from '../lib/focusSettings';
import { playSound, stopSound } from '../lib/focusSound';
import { notificationsSupported, notificationWorker } from '../lib/notifications';
import { useActiveSession } from '../lib/queries';
import { Switch } from './ui';

const isIPhone = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function FocusSettingsCard() {
  const settings = useFocusSettings();
  const { data: session } = useActiveSession();
  const [previewing, setPreviewing] = useState(false);
  const [perm, setPerm] = useState(() => (notificationsSupported() ? Notification.permission : 'unsupported'));

  // The preview stops when you leave Settings, unless a session is running (then the timer owns the sound).
  useEffect(() => () => void (previewing && !session && stopSound()), [previewing, session]);

  const chooseSound = (sound: FocusSound) => {
    setFocusSettings({ sound });
    if (sound === 'off') {
      setPreviewing(false);
      if (!session) stopSound();
    } else if (previewing) void playSound(sound, settings.volume);
  };

  const togglePreview = () => {
    if (previewing) {
      setPreviewing(false);
      if (session?.state !== 'running') stopSound();
    } else {
      setPreviewing(true);
      void playSound(settings.sound, settings.volume);
    }
  };

  const setVolume = (volume: number) => {
    setFocusSettings({ volume });
    if (previewing || session?.state === 'running') void playSound(settings.sound, volume);
  };

  const toggleNotifications = async (on: boolean) => {
    if (!on) return setFocusSettings({ notificationControls: false });
    const result = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    setPerm(result);
    if (result !== 'granted') return;
    await notificationWorker();
    setFocusSettings({ notificationControls: true });
  };

  return (
    <div className="card stack">
      <div>
        <h2>Focus</h2>
        <p className="tiny muted">Saved on this device only. Everything here is optional; the timer works the same with it all off.</p>
      </div>

      <div className="field">
        <span className="label">Focus sound</span>
        <div className="tabs" role="radiogroup" aria-label="Focus sound" style={{ flexWrap: 'wrap', overflow: 'visible' }}>
          {[{ key: 'off' as const, label: 'Off' }, ...FOCUS_SOUNDS].map((s) => (
            <button key={s.key} role="radio" aria-checked={settings.sound === s.key} className={settings.sound === s.key ? 'on' : ''} onClick={() => chooseSound(s.key)}>
              {s.label}
            </button>
          ))}
        </div>
        <span className="hint">Plays while the timer runs and pauses with it.</span>
      </div>

      {settings.sound !== 'off' && (
        <div className="row wrap" style={{ gap: 12 }}>
          <label className="row grow" style={{ gap: 10, minWidth: 200 }}>
            <span className="small">Volume</span>
            <input className="range grow" type="range" min={0} max={1} step={0.05} value={settings.volume} onChange={(e) => setVolume(Number(e.target.value))} aria-label="Sound volume" />
          </label>
          {session?.state !== 'running' && (
            <button className="btn small" onClick={togglePreview}>
              {previewing ? 'Stop preview' : 'Preview'}
            </button>
          )}
        </div>
      )}
      {settings.sound !== 'off' && (
        <p className="tiny muted">
          With a sound on, your phone's lock screen and notification shade show the topic with play and pause, which pause and resume the timer.
          {isIPhone() && ' On iPhone, use the side buttons for volume.'}
        </p>
      )}

      <div className="stack" style={{ gap: 6 }}>
        {perm === 'unsupported' ? (
          <p className="tiny muted">
            This browser can't show timer notifications{isIPhone() ? ' (iPhone Safari)' : ''}. Turn on a focus sound to get pause and play on the lock screen instead.
          </p>
        ) : (
          <>
            <Switch checked={settings.notificationControls && perm === 'granted'} onChange={(on) => void toggleNotifications(on)} label="Timer controls in notifications" />
            <p className="tiny muted">
              {perm === 'denied'
                ? 'Notifications are blocked for this site. Allow them in your browser’s site settings, then turn this on.'
                : 'When you leave the app during a session, a notification shows the topic with Pause / Resume. It disappears when you come back.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
