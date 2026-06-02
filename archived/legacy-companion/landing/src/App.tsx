import { Nav } from "./components/Nav";
import { Hero } from "./components/Hero";
import { Screenshot } from "./components/Screenshot";
import { Features } from "./components/Features";
import { HowItWorks } from "./components/HowItWorks";
import { GetStarted } from "./components/GetStarted";
import { Footer } from "./components/Footer";

export function App() {
  return (
    <div className="bg-cc-bg text-cc-fg min-h-screen relative overflow-hidden paper-noise font-body">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-80"
        style={{
          background:
            "radial-gradient(circle at 12% 16%, rgba(126,183,162,0.26), transparent 40%), radial-gradient(circle at 92% 10%, rgba(183,79,43,0.2), transparent 34%), linear-gradient(152deg, rgba(240,232,217,0.96), rgba(242,233,217,0.76))",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-35"
        style={{
          backgroundImage:
            "linear-gradient(rgba(19,16,13,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(19,16,13,0.08) 1px, transparent 1px)",
          backgroundSize: "64px 64px",
        }}
      />
      <Nav />
      <main className="relative z-10">
        <Hero />
        <Screenshot />
        <Features />
        <HowItWorks />
        <GetStarted />
      </main>
      <Footer />
    </div>
  );
}
