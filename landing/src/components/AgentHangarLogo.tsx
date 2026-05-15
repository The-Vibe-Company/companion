export function AgentHangarLogo({ size = 28 }: { size?: number }) {
  const height = size;
  return (
    <svg
      width={size}
      height={height}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect width="64" height="64" rx="14" fill="#191B1F" />
      <path d="M12 45V28.5C12 19.4 20.9 12 32 12s20 7.4 20 16.5V45" stroke="#F2B36D" strokeWidth="5" strokeLinecap="round" />
      <path d="M20 45V30c0-5.2 5.4-9.5 12-9.5S44 24.8 44 30v15" stroke="#7DD3C7" strokeWidth="4" strokeLinecap="round" />
      <path d="M8 48h48" stroke="#F6E7CF" strokeWidth="4" strokeLinecap="round" />
      <path d="M27 48l-5 10M37 48l5 10" stroke="#F6E7CF" strokeWidth="3" strokeLinecap="round" />
      <path d="M32 33l6 9H26l6-9Z" fill="#F6E7CF" />
      <path d="M32 25v8" stroke="#F6E7CF" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
