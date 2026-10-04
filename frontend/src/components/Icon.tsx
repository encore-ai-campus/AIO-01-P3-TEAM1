const PATHS = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  pie: "M21 12a9 9 0 1 1-9-9v9zM15 3.5A9 9 0 0 1 20.5 9H15z",
  trophy: "M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 21h8M10 17h4v4h-4z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5",
  back: "M15 18l-6-6 6-6",
  chevron: "M9 6l6 6-6 6",
  sparkle: "M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7-4.7-1.8 4.7-1.8zM18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z",
  close: "M6 6l12 12M18 6 6 18",
  alert: "M12 9v4M12 17h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  doc: "M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v5h5M9 13h6M9 17h6",
  check: "M5 12.5l4.5 4.5L19 7.5",
  circle: "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16z",
  ban: "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM6.3 6.3l11.4 11.4",
  skip: "M4 12h11M11 7l5 5-5 5M20 5v14",
  clock: "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 8v4l2.5 2",
  play: "M7 4.5v15l12-7.5z",
  pause: "M8 5v14M16 5v14",
  restart: "M4 12a8 8 0 1 0 2.4-5.7L4 8.5M4 4v4.5h4.5",
  next: "M5 5l9 7-9 7zM19 5v14",
  shield: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  swap: "M4 8h13l-3-3M20 16H7l3 3",
  chart: "M5 20V11M12 20V4M19 20v-6",
  bolt: "M13 3 5 13.5h6L10 21l8-10.5h-6z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = "size-6" }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
