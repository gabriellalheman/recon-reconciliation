import { NextRequest, NextResponse } from 'next/server'

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  // Allow login page and auth API through
  if (pathname === '/login' || pathname === '/api/auth') {
    return NextResponse.next()
  }

  // Check for auth cookie
  const auth = req.cookies.get('auth')?.value
  if (auth === process.env.AUTH_SECRET) {
    return NextResponse.next()
  }

  // Redirect to login
  const loginUrl = req.nextUrl.clone()
  loginUrl.pathname = '/login'
  return NextResponse.redirect(loginUrl)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
