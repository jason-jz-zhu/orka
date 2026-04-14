import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "orka:reviewedSessionIds";
const BOOTSTRAP_KEY = "orka:reviewedBootstrapDone";

function read(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch {
    return new Set();
  }
}

function write(set: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {}
}

// Cross-tab / cross-hook sync via a simple pub-sub.
const listeners = new Set<() => void>();
function notify() {
  for (const fn of listeners) fn();
}

export function useReviewedSessions() {
  const [ids, setIds] = useState<Set<string>>(() => read());

  useEffect(() => {
    const onChange = () => setIds(read());
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }, []);

  const markReviewed = useCallback((id: string) => {
    const next = new Set(read());
    if (next.has(id)) return;
    next.add(id);
    write(next);
    notify();
  }, []);

  const unmarkReviewed = useCallback((id: string) => {
    const next = new Set(read());
    if (!next.has(id)) return;
    next.delete(id);
    write(next);
    notify();
  }, []);

  const markAllReviewed = useCallback((idsToMark: Iterable<string>) => {
    const next = new Set(read());
    let changed = false;
    for (const id of idsToMark) {
      if (!next.has(id)) {
        next.add(id);
        changed = true;
      }
    }
    if (changed) {
      write(next);
      notify();
    }
  }, []);

  const isReviewed = useCallback((id: string) => ids.has(id), [ids]);

  return { isReviewed, markReviewed, unmarkReviewed, markAllReviewed };
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
