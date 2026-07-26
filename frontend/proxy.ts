import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// "/" is public so the homepage works as the front door: a signed-out visitor
// sees the pitch and the Sign in / Sign up controls instead of being bounced
// straight to /sign-in. It is an exact match — "/documents", "/me" and
// "/connect" stay protected, and anything added later is protected by default.
const isPublicRoute = createRouteMatcher(["/", "/sign-in(.*)", "/sign-up(.*)"]);

export default clerkMiddleware(async (auth, request) => {
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
