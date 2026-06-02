import { useEffect, useRef, useState, type ReactNode } from "react";

export function FadeIn({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const show = () => setVisible(true);

    // Fallback: always show after 1.2s regardless
    const fallback = setTimeout(show, 1200);

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          show();
          clearTimeout(fallback);
          observer.unobserve(el);
        }
      },
      { threshold: 0.05, rootMargin: "0px 0px 80px 0px" }
    );

    observer.observe(el);
    return () => {
      clearTimeout(fallback);
      observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={ref}
      className={`transition-all duration-700 ease-out ${
        visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
      } ${className}`}
    >
      {children}
    </div>
  );
}
