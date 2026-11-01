// Test program for fdshim.c (owner decision D-13). Sandbox tooling only. Not audited.
// tests/fdlimit/test.sh builds it (into target/fdlimit/test/) and runs it twice:
//
//   fdshim_test plain   without the shim: raising RLIMIT_NOFILE above the hard limit fails (EPERM).
//   fdshim_test shim    with LD_PRELOAD=fdshim.so: the four interposed calls clamp a NOFILE raise
//                       for this process to the hard limit; lowering, other resources, other
//                       processes, get-only calls and invalid calls behave exactly as without it.
//
// Exit 0 = pass, 1 = fail (each failure printed), 77 = skipped (this process may raise its hard
// limit, e.g. CAP_SYS_RESOURCE, or the hard limit is unlimited: nothing to clamp).
// Only this test process (and a child it starts and kills) is touched.

#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static int failures = 0;

#define CHECK(cond, ...)                                     \
    do {                                                     \
        if (!(cond)) {                                       \
            fprintf(stderr, "FAIL line %d: ", __LINE__);     \
            fprintf(stderr, __VA_ARGS__);                    \
            fprintf(stderr, "\n");                           \
            failures++;                                      \
        }                                                    \
    } while (0)

static struct rlimit nofile(void) {
    struct rlimit r;
    if (getrlimit(RLIMIT_NOFILE, &r) != 0) {
        perror("getrlimit");
        _exit(1);
    }
    return r;
}

// Restores the soft limit (lowering or raising the soft limit up to the hard limit is allowed).
static void restore_soft(rlim_t soft, rlim_t hard) {
    struct rlimit r = {soft, hard};
    CHECK(setrlimit(RLIMIT_NOFILE, &r) == 0, "restoring soft limit failed: %s", strerror(errno));
}

// Which shared object defines `setrlimit` for this process.
static const char *setrlimit_owner(void) {
    Dl_info info;
    if (dladdr((void *)&setrlimit, &info) == 0 || info.dli_fname == NULL) return "?";
    return info.dli_fname;
}

// Raw syscall (bypasses any shim): may this process raise its NOFILE hard limit? Returns 1 if a
// raise to hard + 1 succeeds (then the limit WAS raised; the caller skips), 0 on EPERM.
static int can_raise_natively(rlim_t hard) {
    struct rlimit want = {hard + 1, hard + 1};
    if (syscall(SYS_prlimit64, 0, RLIMIT_NOFILE, &want, NULL) == 0) return 1;
    return 0;
}

static int run_plain(void) {
    struct rlimit start = nofile();
    if (start.rlim_max == RLIM_INFINITY) return 77;
    CHECK(strstr(setrlimit_owner(), "fdshim") == NULL, "setrlimit comes from %s, expected libc", setrlimit_owner());
    struct rlimit want = {start.rlim_max + 1000, start.rlim_max + 1000};
    errno = 0;
    int rc = setrlimit(RLIMIT_NOFILE, &want);
    if (rc == 0) return 77; // this process may raise it: nothing to show
    CHECK(errno == EPERM, "plain raise: errno %d (%s), expected EPERM", errno, strerror(errno));
    struct rlimit after = nofile();
    CHECK(after.rlim_max == start.rlim_max && after.rlim_cur == start.rlim_cur, "plain raise changed the limit");
    return failures ? 1 : 0;
}

static int run_shim(void) {
    struct rlimit start = nofile();
    const rlim_t soft = start.rlim_cur, hard = start.rlim_max;
    if (hard == RLIM_INFINITY) return 77;
    if (can_raise_natively(hard)) return 77;
    CHECK(strstr(setrlimit_owner(), "fdshim") != NULL, "setrlimit comes from %s, expected fdshim.so", setrlimit_owner());

    // 1. setrlimit: the neard request (65535, 65535) or anything above the hard limit is clamped.
    struct rlimit want = {hard + 1000, hard + 1000};
    if (hard < 65535) want.rlim_cur = want.rlim_max = 65535;
    errno = 0;
    CHECK(setrlimit(RLIMIT_NOFILE, &want) == 0, "setrlimit raise: %s", strerror(errno));
    struct rlimit now = nofile();
    CHECK(now.rlim_max == hard && now.rlim_cur == hard, "setrlimit: got (%llu, %llu), expected (%llu, %llu)",
          (unsigned long long)now.rlim_cur, (unsigned long long)now.rlim_max, (unsigned long long)hard,
          (unsigned long long)hard);
    restore_soft(soft, hard);

    // 2. setrlimit64, with a soft limit below the hard limit: soft is kept, hard is clamped.
    rlim64_t low_soft = hard > 64 ? 64 : hard;
    struct rlimit64 want64 = {low_soft, (rlim64_t)hard + 5};
    CHECK(setrlimit64(RLIMIT_NOFILE, &want64) == 0, "setrlimit64 raise: %s", strerror(errno));
    now = nofile();
    CHECK(now.rlim_max == hard && now.rlim_cur == low_soft, "setrlimit64: got (%llu, %llu), expected (%llu, %llu)",
          (unsigned long long)now.rlim_cur, (unsigned long long)now.rlim_max, (unsigned long long)low_soft,
          (unsigned long long)hard);
    restore_soft(soft, hard);

    // 3. prlimit, pid 0, unlimited request: clamped; old_limit reports the limit before the call.
    struct rlimit inf = {RLIM_INFINITY, RLIM_INFINITY}, old = {0, 0};
    CHECK(prlimit(0, RLIMIT_NOFILE, &inf, &old) == 0, "prlimit(0) raise: %s", strerror(errno));
    CHECK(old.rlim_cur == soft && old.rlim_max == hard, "prlimit(0): old limit (%llu, %llu)",
          (unsigned long long)old.rlim_cur, (unsigned long long)old.rlim_max);
    now = nofile();
    CHECK(now.rlim_max == hard && now.rlim_cur == hard, "prlimit(0): not clamped to the hard limit");
    restore_soft(soft, hard);

    // 4. prlimit64 with this process's own pid: clamped.
    struct rlimit64 want64b = {(rlim64_t)hard + 1, (rlim64_t)hard + 1};
    CHECK(prlimit64(getpid(), RLIMIT_NOFILE, &want64b, NULL) == 0, "prlimit64(getpid()) raise: %s", strerror(errno));
    now = nofile();
    CHECK(now.rlim_max == hard && now.rlim_cur == hard, "prlimit64(getpid()): not clamped to the hard limit");
    restore_soft(soft, hard);

    // 5. Lowering the soft limit passes through.
    struct rlimit lower = {low_soft, hard};
    CHECK(setrlimit(RLIMIT_NOFILE, &lower) == 0 && nofile().rlim_cur == low_soft, "lowering the soft limit failed");
    restore_soft(soft, hard);

    // 6. Get-only prlimit passes through.
    struct rlimit got = {0, 0};
    CHECK(prlimit(0, RLIMIT_NOFILE, NULL, &got) == 0 && got.rlim_cur == soft && got.rlim_max == hard,
          "get-only prlimit changed or misreported the limit");

    // 7. Another process is never clamped: the raise is refused as without the shim.
    pid_t child = fork();
    if (child == 0) {
        pause();
        _exit(0);
    }
    CHECK(child > 0, "fork failed");
    if (child > 0) {
        struct rlimit other = {hard + 1, hard + 1};
        errno = 0;
        int rc = prlimit(child, RLIMIT_NOFILE, &other, NULL);
        CHECK(rc == -1 && errno == EPERM, "prlimit(child) raise: expected -1/EPERM, got %d/errno %d", rc, errno);
        struct rlimit64 other64 = {(rlim64_t)hard + 1, (rlim64_t)hard + 1};
        errno = 0;
        rc = prlimit64(child, RLIMIT_NOFILE, &other64, NULL);
        CHECK(rc == -1 && errno == EPERM, "prlimit64(child) raise: expected -1/EPERM, got %d/errno %d", rc, errno);
        kill(child, SIGKILL);
        waitpid(child, NULL, 0);
    }

    // 8. Other resources pass through: a raise above a finite hard limit is still refused.
    static const int others[] = {RLIMIT_CORE, RLIMIT_STACK, RLIMIT_NPROC, RLIMIT_MEMLOCK, RLIMIT_MSGQUEUE,
                                 RLIMIT_SIGPENDING, RLIMIT_LOCKS, RLIMIT_RTPRIO, RLIMIT_NICE, RLIMIT_FSIZE};
    int tested_other = 0;
    for (size_t i = 0; i < sizeof others / sizeof others[0] && !tested_other; i++) {
        struct rlimit r;
        if (getrlimit(others[i], &r) != 0 || r.rlim_max == RLIM_INFINITY) continue;
        struct rlimit up = {r.rlim_max + 1, r.rlim_max + 1};
        errno = 0;
        int rc = setrlimit(others[i], &up);
        CHECK(rc == -1 && errno == EPERM, "resource %d raise: expected -1/EPERM, got %d/errno %d", others[i], rc, errno);
        struct rlimit after;
        CHECK(getrlimit(others[i], &after) == 0 && after.rlim_max == r.rlim_max, "resource %d changed", others[i]);
        tested_other = 1;
    }
    if (!tested_other) fprintf(stderr, "note: no other resource with a finite hard limit; check 8 skipped\n");

    // 9. Invalid requests keep their own error: soft above hard (EINVAL), unknown resource (EINVAL).
    struct rlimit bad = {hard, hard - 1};
    errno = 0;
    int rc = setrlimit(RLIMIT_NOFILE, &bad);
    CHECK(rc == -1 && errno == EINVAL, "soft > hard: expected -1/EINVAL, got %d/errno %d", rc, errno);
    errno = 0;
    rc = setrlimit((__rlimit_resource_t)4242, &start);
    CHECK(rc == -1 && errno == EINVAL, "unknown resource: expected -1/EINVAL, got %d/errno %d", rc, errno);

    now = nofile();
    CHECK(now.rlim_cur == soft && now.rlim_max == hard, "limit not restored at the end");
    return failures ? 1 : 0;
}

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "plain") == 0) return run_plain();
    if (argc == 2 && strcmp(argv[1], "shim") == 0) return run_shim();
    fprintf(stderr, "usage: fdshim_test plain|shim\n");
    return 2;
}
