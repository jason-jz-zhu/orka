import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MeetingModal } from "./MeetingModal";
import { makeSession } from "../test-helpers/session-fixtures";

vi.mock("../lib/tauri", () => ({
  invokeCmd: vi.fn(async () => null),
  inTauri: false,
  listenEvent: vi.fn(() => Promise.resolve(() => undefined)),
}));

import { invokeCmd } from "../lib/tauri";
const mockInvoke = invokeCmd as unknown as ReturnType<typeof vi.fn>;

describe("MeetingModal", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async () => null);
  });

  it("renders attendees and three preset agendas", async () => {
    const attendees = [
      makeSession({ id: "a1", project_cwd: "/tmp/project-a", turn_count: 4 }),
      makeSession({ id: "a2", project_cwd: "/tmp/project-b", turn_count: 7 }),
    ];
    render(<MeetingModal attendees={attendees} onClose={() => {}} />);

    // Attendees row should show both project names.
    await waitFor(() => {
      expect(screen.getByText("project-a")).toBeInTheDocument();
    });
    expect(screen.getByText("project-b")).toBeInTheDocument();
    // One preset per canonical meeting archetype.
    const presets = screen.getAllByRole("button", {
      name: /summarize|themes|decision doc/i,
    });
    expect(presets.length).toBe(3);
  });

  it("clicking a preset dispatches synthesize_sessions_stream with the agenda text", async () => {
    const attendees = [makeSession({ id: "a1" }), makeSession({ id: "a2" })];
    render(<MeetingModal attendees={attendees} onClose={() => {}} />);

    const preset = await screen.findByRole("button", {
      name: /decision doc/i,
    });
    await userEvent.click(preset);

    // The Rust command is the same synthesis entrypoint — we're just
    // checking the UI wires the preset text through as the question.
    await waitFor(() => {
      const call = mockInvoke.mock.calls.find(
        (c) => c[0] === "synthesize_sessions_stream",
      );
      expect(call).toBeTruthy();
      const args = call![1] as { question: string; sources: unknown[] };
      expect(args.question.toLowerCase()).toContain("decision doc");
      expect(args.sources).toHaveLength(2);
    });
  });

  it("calls close when the ✕ button fires", async () => {
    const onClose = vi.fn();
    const attendees = [makeSession({ id: "a1" }), makeSession({ id: "a2" })];
    render(<MeetingModal attendees={attendees} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "✕" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
