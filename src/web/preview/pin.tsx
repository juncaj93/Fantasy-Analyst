/**
 * The previews' PIN (Rounds 19, 24, 26 and 35): one gate, the same PIN, shared
 * by every preview shell. Built only for the preview upload.
 */

import { useState } from 'react';

/** SHA-256 of the PIN, so the page carries no PIN in plain text. */
const PIN_HASH = '9cbc798b1a61514459ddaae0c12995e339d649e82ea0c2d257c11c48f2329e01';
const UNLOCK_KEY = 'fa.preview.unlocked';

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function wasUnlocked(): boolean {
  try {
    return window.sessionStorage.getItem(UNLOCK_KEY) === PIN_HASH;
  } catch {
    return false;
  }
}

export function PinGate({ title, onUnlock }: { title: string; onUnlock: () => void }) {
  const [pin, setPin] = useState('');
  const [wrong, setWrong] = useState(false);
  const submit = async () => {
    if ((await sha256(pin.trim())) === PIN_HASH) {
      try {
        window.sessionStorage.setItem(UNLOCK_KEY, PIN_HASH);
      } catch {
        /* unlocked for this page only */
      }
      onUnlock();
    } else {
      setWrong(true);
    }
  };
  return (
    <form
      className="t2-pin"
      data-testid="preview-pin"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h1 className="t2-question">{title}</h1>
      <input
        inputMode="numeric"
        autoComplete="off"
        aria-label="PIN"
        placeholder="PIN"
        value={pin}
        onChange={(e) => {
          setPin(e.target.value);
          setWrong(false);
        }}
        data-testid="preview-pin-input"
      />
      {wrong ? <div className="t2-note">That PIN is not right.</div> : null}
      <button type="submit" className="btn btn-primary" data-testid="preview-pin-go">
        Open
      </button>
    </form>
  );
}
