import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// "/" is public so the landing page works as the front door: a signed-out visitor
// sees the pitch and the Sign in / Sign up controls instead of being bounced
// straight to /sign-in. It is an exact match — "/dashboard", "/clients", "/documents",
// "/me" and "/connect" stay protected, and anything added later is protected by default.
const isPublicRoute = createRouteMatcher(["/", "/sign-in(.*)", "/sign-up(.*)"]);

export default clerkMiddleware(async (auth, request) => {
  const { userId } = await auth();

  // A signed-in visitor never sees the landing page — it is the signed-out front door,
  // and the app proper starts at /dashboard. Deciding this here rather than in the page
  // keeps `auth()` out of app/page.tsx, so the landing stays prerenderable.
  if (userId && request.nextUrl.pathname === "/") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  if (!isPublicRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
