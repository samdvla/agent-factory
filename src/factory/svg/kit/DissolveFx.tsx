export default function DissolveFx({ accent, scale = 1 }: { accent: string; scale?: number }) {
  const dots = Array.from({ length: 12 }, (_, i) => i);
  return (
    <span
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        transform: `scale(${scale})`,
        transformOrigin: "50% 100%",
      }}
      aria-hidden
    >
      {dots.map((i) => {
        const angle = (i / dots.length) * Math.PI * 2;
        const r = 28;
        const x = Math.cos(angle) * r;
        const y = Math.sin(angle) * r - 12;
        return (
          <span
            key={i}
            style={{
              position: "absolute",
              left: 16 + x,
              top: 12 + y,
              width: 4,
              height: 4,
              borderRadius: 4,
              background: accent,
              opacity: 0.9,
              animation: `dissolve-dot-${i} 600ms ease-in forwards`,
              ["--tx" as string]: `${-x}px`,
              ["--ty" as string]: `${-y}px`,
            }}
          />
        );
      })}
      <style>{
        Array.from({ length: 12 }).map((_, i) => `
          @keyframes dissolve-dot-${i} {
            from { transform: translate(0,0); opacity: 0.9; }
            to   { transform: translate(var(--tx), var(--ty)); opacity: 0; }
          }
        `).join("\n")
      }</style>
    </span>
  );
}
