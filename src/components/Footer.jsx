import Link from "next/link";

export const Footer = () => {
  return (
    <footer className="border-t border-[#E5E2D9] bg-[#FDFBF7]" data-testid="footer">
      <div className="max-w-7xl mx-auto px-6 md:px-12 py-14 flex flex-col md:flex-row items-start md:items-end justify-between gap-8">
        <div>
          <span className="font-serif text-3xl font-semibold tracking-tight text-[#1A1A1A]">
            Answer<span className="text-[#D9531E]">Rank</span>
          </span>
          <p className="mt-3 text-sm text-[#666666] max-w-xs leading-relaxed">
            Answer-engine visibility, measured. Know where AI recommends you — and where it doesn't.
          </p>
        </div>
        <div className="flex flex-col items-start md:items-end gap-3">
          <div className="flex items-center gap-8 text-xs uppercase tracking-[0.12em] font-medium text-[#666666]">
            <Link href="/scan" className="hover:text-[#1A1A1A] transition-colors">
              Run a check
            </Link>
            <Link href="/dashboard" className="hover:text-[#1A1A1A] transition-colors">
              Dashboard
            </Link>
          </div>
          <span className="text-xs text-[#999999]">
            © {new Date().getFullYear()} AnswerRank. All rights reserved.
          </span>
        </div>
      </div>
    </footer>
  );
};
