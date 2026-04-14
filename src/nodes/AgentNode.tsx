import ChatNode from "./ChatNode";
import type { NodeProps } from "@xyflow/react";
import type { OrkaNode } from "../lib/graph-store";

export default function AgentNode(
  props: NodeProps<Extract<OrkaNode, { type: "agent" }>>
) {
  return <ChatNode {...(props as any)} variant="agent" />;
}
