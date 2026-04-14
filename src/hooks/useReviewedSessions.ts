import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "orka:reviewedSessionMtimes";
const BOOTSTRAP_KEY = "orka:reviewedBootstrapDone";

/**
 * We store reviewed state as `sessionId → modified_ms at the moment of
 * review`. A session counts as "reviewed" only when its CURRENT mtime matches
 * the stored one — i.e. nothing has changed since you looked at it.
 *
 * When Claude writes a new turn, mtime increases, the match fails, and the
 * card flips back to FOR REVIEW naturally. No live "transition detection"
 * needed; it survives Orka reloads.
 */
type ReviewedMap = Record<string, number>;

function read(): ReviewedMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ReviewedMap;
    }
    return {};
  } catch {
    return {};
  }
}

function write(map: ReviewedMap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {}
}

// Cross-hook sync.
const listeners = new Set<() => void>();
function notify() {
  for (const fn of listeners) fn();
}

export function useReviewedSessions() {
  const [map, setMap] = useState<ReviewedMap>(() => read());
  const mapRef = useRef(map);
  mapRef.current = map;

  useEffect(() => {
    const onChange = () => setMap(read());
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }, []);

  // mark session as reviewed AT the given mtime (usually session.modified_ms
  // at the moment the user clicked Review).
  const markReviewed = useCallback((id: string, mtime: number) => {
    const next = { ...read() };
    next[id] = mtime;
    write(next);
    notify();
  }, []);

  const unmarkReviewed = useCallback((id: string) => {
    const next = { ...read() };
    if (!(id in next)) return;
    delete next[id];
    write(next);
    notify();
  }, []);

  const markAllReviewed = useCallback(
    (entries: Iterable<[string, number]>) => {
      const next = { ...read() };
      let changed = false;
      for (const [id, mtime] of entries) {
        if (next[id] !== mtime) {
          next[id] = mtime;
          changed = true;
        }
      }
      if (changed) {
        write(next);
        notify();
      }
    },
    []
  );

  // Stable callback reading through ref.
  // A session is "reviewed" only if its current mtime matches what we stored
  // at review time. If Claude has since written, the mtime advances and the
  // session naturally un-reviews.
  const isReviewed = useCallback(
    (id: string, currentMtime: number) =>
      mapRef.current[id] === currentMtime,
    []
  );

  return {
    isReviewed,
    reviewedMap: map,
    markReviewed,
    unmarkReviewed,
    markAllReviewed,
  };
}

export function hasBootstrapped(): boolean {
  try {
    return localStorage.getItem(BOOTSTRAP_KEY) === "1";
  } catch {
    return false;
  }
}

export function markBootstrapped() {
  try {
    localStorage.setItem(BOOTSTRAP_KEY, "1");
  } catch {}
}
