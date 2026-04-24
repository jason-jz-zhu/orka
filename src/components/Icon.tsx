import {
  Check,
  X,
  ChevronDown,
  ChevronRight,
  RotateCw,
  Keyboard,
  Clock,
  Settings,
  Sparkles,
  Lightbulb,
  Bot,
  Folder,
  FileText,
  File,
  Package,
  Phone,
  MapPin,
  Bell,
  Moon,
  AlertTriangle,
  type LucideProps,
} from "lucide-react";

/**
 * Project-wide icon name registry. Adding a new variant is a one-line
 * mapping addition — keeps imports off individual component files and
 * makes a future swap (Lucide → Phosphor → custom set) a single-file
 * change.
 *
 * Sprint 2 of the design polish pass: replaces the most-mixed emoji
 * uses (status, navigation, common feature labels) with a consistent
 * stroke icon set. Emoji that genuinely carries warmth/personality
 * (🌙 overnight, 🗣 chat role) stays as inline emoji on purpose.
 */
const REGISTRY = {
  // Status (P0)
  check: Check,
  x: X,
  // Navigation (P0)
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  // Controls (P0)
  refresh: RotateCw,
  keyboard: Keyboard,
  clock: Clock,
  settings: Settings,
  // Feature (P1)
  sparkles: Sparkles,
  lightbulb: Lightbulb,
  bot: Bot,
  folder: Folder,
  "file-text": FileText,
  file: File,
  package: Package,
  phone: Phone,
  "map-pin": MapPin,
  bell: Bell,
  moon: Moon,
  warning: AlertTriangle,
} as const;

export type IconName = keyof typeof REGISTRY;

type Props = Omit<LucideProps, "ref"> & {
  name: IconName;
};

/**
 * Render a Lucide icon with project-defaults: 14px size + 1.75px
 * stroke. Pass any Lucide prop to override (e.g. `size={12}` for
 * dense rows, `color="currentColor"` to inherit text color).
 */
export function Icon({ name, size = 14, strokeWidth = 1.75, ...rest }: Props) {
  const Glyph = REGISTRY[name];
  if (!Glyph) {
    if (typeof console !== "undefined") {
      console.warn(`<Icon> unknown name: ${name as string}`);
    }
    return null;
  }
  return <Glyph size={size} strokeWidth={strokeWidth} {...rest} />;
}
