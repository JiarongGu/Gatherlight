import { useState } from 'react';

// Shown when a conversation reaches a terminal state — the user ranks it 1–5 (+ optional note).
// The rating feeds the LLM-tuning / eval dataset surfaced in the management console.
const TERMINAL = ['committed', 'rejected', 'cancelled', 'done', 'error'];

export function ChatRating({ sessionId, phase }: { sessionId: string | null; phase: string }) {
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);

  if (!sessionId || !TERMINAL.includes(phase)) return null;

  const submit = async (r: number) => {
    setRating(r);
    try {
      await fetch(`/api/chat/${sessionId}/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating: r, note: note.trim() || null }),
      });
      setSent(true);
    } catch {
      /* ignore — rating is best-effort */
    }
  };

  if (sent) {
    return (
      <div className="chat-rating done">
        <span className="chat-stars-static">{'★'.repeat(rating)}{'☆'.repeat(5 - rating)}</span>
        已评分 · 谢谢,这会用于调优 AI。
      </div>
    );
  }

  const shown = hover || rating;
  return (
    <div className="chat-rating">
      <div className="chat-rating-label">为这次对话打分 · 帮助调优 AI</div>
      <div className="chat-rating-row">
        <div className="chat-stars" onMouseLeave={() => setHover(0)}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              className={`chat-star${shown >= n ? ' on' : ''}`}
              onMouseEnter={() => setHover(n)}
              onClick={() => submit(n)}
              aria-label={`${n} 星`}
            >
              ★
            </button>
          ))}
        </div>
        <input
          className="chat-rating-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="可选备注(哪里好/差)…"
        />
      </div>
    </div>
  );
}
