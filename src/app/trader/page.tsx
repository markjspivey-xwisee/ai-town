import { SignedIn, SignedOut, UserButton } from '@clerk/nextjs';
import Link from 'next/link';
import TraderDashboard from '@/components/trader/TraderDashboard';
import LoginButton from '@/components/LoginButton';

export const metadata = {
  title: 'Autonomous OANDA Crypto Trader',
  description:
    'Configure and run a fully autonomous crypto trading agent that executes on the OANDA platform.',
};

export default function TraderPage() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-between font-body game-background">
      <div className="p-6 absolute top-0 right-0 z-10 text-2xl">
        <SignedIn>
          <UserButton afterSignOutUrl="/" />
        </SignedIn>
        <SignedOut>
          <LoginButton />
        </SignedOut>
      </div>

      <div className="w-full min-h-screen relative isolate overflow-hidden p-6 lg:p-8 shadow-2xl flex flex-col gap-6">
        <div className="flex items-center justify-between text-white">
          <Link href="/" className="text-sm text-clay-200 hover:text-white underline decoration-dotted">
            ← Back to AI Town
          </Link>
          <div className="text-right text-xs text-clay-200">
            <p>Requires OANDA API credentials to execute live orders.</p>
            <p>Set OANDA_API_KEY and OANDA_ACCOUNT_ID in Convex env variables.</p>
          </div>
        </div>
        <TraderDashboard />
      </div>
    </main>
  );
}
