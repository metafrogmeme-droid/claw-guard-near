// Sandbox only. Prototype. Not audited.
//
// fdshim: LD_PRELOAD shim for the LOCAL NEAR sandbox node only (owner decision D-13,
// docs/DECISIONS.md).
//
// Why: the sandbox node (near-sandbox / neard 2.14.0) calls
// setrlimit(RLIMIT_NOFILE, {65535, 65535}) at start, even for `--version`, and exits with
//   couldn't set the file descriptor limit to (65535, 65535), current limit = (H, H)
// when the host's hard open-files limit H is lower and the process may not raise it (no
// CAP_SYS_RESOURCE, for example a container started with a 20000 limit). A local test chain
// needs far fewer open files than that.
//
// What: interposes setrlimit, setrlimit64, prlimit and prlimit64. Only an RLIMIT_NOFILE request
// for the calling process (prlimit pid 0 or getpid()) that the kernel refuses with EPERM and that
// asks for a hard limit above the current one is changed: rlim_max is clamped to the current hard
// limit, rlim_cur to rlim_max, and the clamped request is made instead. Every other call goes to
// the real function unchanged (dlsym RTLD_NEXT). The shim never raises a limit, never touches
// another resource or another process, and does nothing when the original request succeeds.
//
// Where: loaded into the sandbox binary only, by scripts/fdlimit/near-sandbox-wrapper.sh, which
// `make demo` / `make test` use only when the hard limit is below 65535 (scripts/sandbox_env.sh).
// Never used for NEAR testnet or anything else. Linux with glibc on 64-bit (x86_64, aarch64);
// scripts/sandbox_env.sh skips it on other systems.
//
// Build (scripts/sandbox_env.sh does this, output is git-ignored):
//   cc -shared -fPIC -O2 -Wall -Wextra -Werror -o target/fdlimit/fdshim.so scripts/fdlimit/fdshim.c -ldl

#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stddef.h>
#include <sys/resource.h>
#include <sys/types.h>
#include <unistd.h>

#if !defined(__linux__) || !defined(__GLIBC__)
#error "fdshim supports Linux with glibc only"
#endif

// On 64-bit glibc, rlim_t and rlim64_t are the same 64-bit type; the shim relies on it.
_Static_assert(sizeof(rlim_t) == 8 && sizeof(rlim64_t) == 8, "fdshim needs 64-bit rlim_t (x86_64 or aarch64 glibc)");

typedef int (*setrlimit_fn)(__rlimit_resource_t, const struct rlimit *);
typedef int (*setrlimit64_fn)(__rlimit_resource_t, const struct rlimit64 *);
typedef int (*prlimit_fn)(pid_t, __rlimit_resource_t, const struct rlimit *, struct rlimit *);
typedef int (*prlimit64_fn)(pid_t, __rlimit_resource_t, const struct rlimit64 *, struct rlimit64 *);

// The next definition of `name` after this shim (normally glibc's). Looked up on every call:
// these calls are rare, and it avoids shared mutable state between threads.
static void *next_symbol(const char *name) {
    return dlsym(RTLD_NEXT, name);
}

// Computes the clamped request for an RLIMIT_NOFILE request (want_cur, want_max) that asks for a
// hard limit above the current one. Returns 1 and fills *cur, *max; returns 0 if the request does
// not ask for more than the current hard limit (or the limit cannot be read): nothing to clamp.
// RLIM64_INFINITY is the largest value, so "unlimited" requests are clamped too.
static int clamp_nofile(rlim64_t want_cur, rlim64_t want_max, rlim64_t *cur, rlim64_t *max) {
    struct rlimit64 now;
    if (getrlimit64(RLIMIT_NOFILE, &now) != 0) return 0;
    if (want_max <= now.rlim_max) return 0;
    *max = now.rlim_max;
    *cur = want_cur < now.rlim_max ? want_cur : now.rlim_max;
    return 1;
}

static int is_nofile(__rlimit_resource_t resource) {
    return (int)resource == (int)RLIMIT_NOFILE;
}

static int is_self(pid_t pid) {
    return pid == 0 || pid == getpid();
}

// setrlimit / setrlimit64: glibc declares `rlim` nonnull, and a NULL request makes the real call
// return 0 (the kernel then sets nothing), so after an EPERM `rlim` is a valid pointer.

int setrlimit(__rlimit_resource_t resource, const struct rlimit *rlim) {
    setrlimit_fn real = (setrlimit_fn)next_symbol("setrlimit");
    if (real == NULL) {
        errno = ENOSYS;
        return -1;
    }
    int rc = real(resource, rlim);
    if (rc == 0 || errno != EPERM || !is_nofile(resource)) return rc;
    struct rlimit clamped;
    if (!clamp_nofile(rlim->rlim_cur, rlim->rlim_max, &clamped.rlim_cur, &clamped.rlim_max)) {
        errno = EPERM;
        return rc;
    }
    return real(resource, &clamped);
}

int setrlimit64(__rlimit_resource_t resource, const struct rlimit64 *rlim) {
    setrlimit64_fn real = (setrlimit64_fn)next_symbol("setrlimit64");
    if (real == NULL) {
        errno = ENOSYS;
        return -1;
    }
    int rc = real(resource, rlim);
    if (rc == 0 || errno != EPERM || !is_nofile(resource)) return rc;
    struct rlimit64 clamped;
    if (!clamp_nofile(rlim->rlim_cur, rlim->rlim_max, &clamped.rlim_cur, &clamped.rlim_max)) {
        errno = EPERM;
        return rc;
    }
    return real(resource, &clamped);
}

int prlimit(pid_t pid, __rlimit_resource_t resource, const struct rlimit *new_limit, struct rlimit *old_limit) {
    prlimit_fn real = (prlimit_fn)next_symbol("prlimit");
    if (real == NULL) {
        errno = ENOSYS;
        return -1;
    }
    int rc = real(pid, resource, new_limit, old_limit);
    if (rc == 0 || errno != EPERM || !is_nofile(resource) || new_limit == NULL || !is_self(pid)) return rc;
    struct rlimit clamped;
    if (!clamp_nofile(new_limit->rlim_cur, new_limit->rlim_max, &clamped.rlim_cur, &clamped.rlim_max)) {
        errno = EPERM;
        return rc;
    }
    return real(pid, resource, &clamped, old_limit);
}

int prlimit64(pid_t pid, __rlimit_resource_t resource, const struct rlimit64 *new_limit, struct rlimit64 *old_limit) {
    prlimit64_fn real = (prlimit64_fn)next_symbol("prlimit64");
    if (real == NULL) {
        errno = ENOSYS;
        return -1;
    }
    int rc = real(pid, resource, new_limit, old_limit);
    if (rc == 0 || errno != EPERM || !is_nofile(resource) || new_limit == NULL || !is_self(pid)) return rc;
    struct rlimit64 clamped;
    if (!clamp_nofile(new_limit->rlim_cur, new_limit->rlim_max, &clamped.rlim_cur, &clamped.rlim_max)) {
        errno = EPERM;
        return rc;
    }
    return real(pid, resource, &clamped, old_limit);
}
