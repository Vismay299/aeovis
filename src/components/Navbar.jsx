import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

export const Navbar = () => {
  const pathname = usePathname();
  const router = useRouter();
  const onLanding = pathname === "/";

  return (
    <header
      data-testid="navbar"
      className="sticky top-0 z-50 bg-[#FDFBF7]/90 backdrop-blur-md border-b border-[#E5E2D9]"
    >
      <div className="max-w-7xl mx-auto px-6 md:px-12 h-[72px] flex items-center justify-between">
        <Link href="/" data-testid="nav-logo" className="flex items-baseline gap-2 group">
          <span className="font-serif text-2xl font-semibold tracking-tight text-[#1A1A1A]">
            Answer<span className="text-[#D9531E]">Rank</span>
          </span>
          <span className="hidden sm:inline text-[10px] uppercase tracking-[0.2em] text-[#999999] font-medium">
            AEO
          </span>
        </Link>

        <nav className="hidden md:flex items-center gap-10 text-xs uppercase tracking-[0.12em] font-medium text-[#666666]">
          {onLanding && (
            <>
              <a href="#how" className="hover:text-[#1A1A1A] transition-colors" data-testid="nav-how">
                Method
              </a>
              <a href="#preview" className="hover:text-[#1A1A1A] transition-colors" data-testid="nav-preview">
                The Report
              </a>
              <a href="#usecases" className="hover:text-[#1A1A1A] transition-colors" data-testid="nav-usecases">
                Who it's for
              </a>
            </>
          )}
        </nav>

        <div className="flex items-center gap-5">
          <Link
            href="/dashboard"
            data-testid="nav-dashboard-link"
            className="hidden sm:inline-flex text-xs uppercase tracking-[0.12em] font-medium text-[#666666] hover:text-[#1A1A1A] transition-colors"
          >
            Dashboard
          </Link>
          <button
            data-testid="nav-cta"
            onClick={() => router.push("/scan")}
            className="bg-[#D9531E] text-white hover:bg-[#B34115] transition-colors rounded-sm px-5 py-2.5 font-sans font-semibold text-xs uppercase tracking-[0.1em]"
          >
            Run a check
          </button>
        </div>
      </div>
    </header>
  );
};
