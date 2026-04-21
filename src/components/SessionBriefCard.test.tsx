import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionBriefCard, type SessionBrief } from "./SessionBriefCard";

// Hoist-safe mock of the tauri bridge: the component imports `invokeCmd`
// from `../lib/tauri`, so replacing that module lets us control every
// command per test without touching real Tauri/fetch.
vi.mock("../lib/tauri", () => ({
  invokeCmd: vi.fn(),
  inTauri: false,
  listenEvent: vi.fn(() => Promise.resolve(() => undefined)),
}));

import { invokeCmd } from "../lib/tauri";

const mockInvoke = invokeCmd as unknown as ReturnType<typeof vi.fn>;

function setInvoke(handler: (cmd: string) => unknown) {
  mockInvoke.mockImplementation((cmd: string) => Promise.resolve(handler(cmd)));
}

const sampleBrief: SessionBrief = {
  sessionId: "s1",
  youWere: "Debugging the dashboard",
  progress: "Fixed the awaiting_user logic",
  nextLikely: "run the new tests",
  sourceMtimeMs: 1,
  generatedAt: "2026-04-21T00:00:00Z",
};

describe("SessionBriefCard", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("renders the cached brief when get_session_brief returns one", async () => {
    setInvoke((cmd) => (cmd === "get_session_brief" ? sampleBrief : null));

    render(
      <SessionBriefCard sessionId="s1" sessionPath="/tmp/s1.jsonl" autoGenerate={false} />,
    );

    expect(await screen.findByText("Debugging the dashboard")).toBeInTheDocument();
    // Body composes progress + nextLikely around an arrow.
    expect(screen.getByText(/Fixed the awaiting_user logic/)).toBeInTheDocument();
    expect(screen.getByText(/run the new tests/)).toBeInTheDocument();
  });

  it("shows the 'Brief me' button when no cached brief and autoGenerate=false", async () => {
    setInvoke(() => null);

    render(
      <SessionBriefCard sessionId="s1" sessionPath="/tmp/s1.jsonl" autoGenerate={false} />,
    );

    const btn = await screen.findByRole("button", { name: /Brief me/ });
    expect(btn).toBeInTheDocument();
  });

  it("clicking 'Brief me' calls generate_session_brief and then renders the result", async () => {
    // First call (cache probe) returns null; the subsequent
    // generate_session_brief call returns the brief.
    setInvoke((cmd) => {
      if (cmd === "get_session_brief") return null;
      if (cmd === "generate_session_brief") return sampleBrief;
      return null;
    });

    render(
      <SessionBriefCard sessionId="s1" sessionPath="/tmp/s1.jsonl" autoGenerate={false} />,
    );

    const btn = await screen.findByRole("button", { name: /Brief me/ });
    await userEvent.click(btn);

    expect(await screen.findByText("Debugging the dashboard")).toBeInTheDocument();
    expect(
      mockInvoke.mock.calls.some((c) => c[0] === "generate_session_brief"),
    ).toBe(true);
  });

  it("does not crash when generate_session_brief resolves to null", async () => {
    // Regression: SessionBriefCard used to blindly destructure
    // `brief.progress` in its render branch; if a stub (or a legitimate
    // backend edge case) returned null, the whole card crashed and took
    // the session list with it. Expected behaviour now: fall back to
    // idle/error, never throw.
    setInvoke((cmd) => {
      if (cmd === "get_session_brief") return null;
      if (cmd === "generate_session_brief") return null;
      return null;
    });

    render(
      <SessionBriefCard sessionId="s1" sessionPath="/tmp/s1.jsonl" autoGenerate={true} />,
    );

    // Either the Brief-me button (idle fallback) OR an error surface is
    // acceptable — what is NOT acceptable is a thrown crash.
    await waitFor(
      () => {
        const hasFallback =
          screen.queryByText(/Brief me/i) ?? screen.queryByText(/Brief failed/i);
        expect(hasFallback).not.toBeNull();
      },
      { timeout: 2000 },
    );
  });

  it("surfaces an error if the brief generation fails", async () => {
    setInvoke(() => null);
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_session_brief") return Promise.resolve(null);
      return Promise.reject(new Error("boom"));
    });

    render(
      <SessionBriefCard sessionId="s1" sessionPath="/tmp/s1.jsonl" autoGenerate={true} />,
    );

    await waitFor(
      () => expect(screen.getByText(/Brief failed/i)).toBeInTheDocument(),
      { timeout: 2000 },
    );
  });
});
