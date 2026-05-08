// Vakka egress-audit shim (Phase 0.5, capture-only).
//
// DYLD_INTERPOSE on getaddrinfo + connect. Logs every hostname lookup and
// outbound connection 5-tuple to ~/.vakka/egress-audit.ndjson, one JSON
// object per line. Read-only — never blocks, never rewrites.
//
// Build: see shim/Makefile (audit target).
// Run:   DYLD_INSERT_LIBRARIES=dist/libvakka-audit.dylib ~/.vakka/claude-2.1.126

#include <arpa/inet.h>
#include <errno.h>
#include <netdb.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

// ---- DYLD_INTERPOSE machinery ----------------------------------------------
#define DYLD_INTERPOSE(_repl, _orig)                                         \
  __attribute__((used)) static struct {                                      \
    const void *repl;                                                        \
    const void *orig;                                                        \
  } _interpose_##_orig __attribute__((section("__DATA,__interpose"))) = {    \
      (const void *)(unsigned long)&_repl, (const void *)(unsigned long)&_orig}

// ---- log sink --------------------------------------------------------------
static pthread_mutex_t log_mu = PTHREAD_MUTEX_INITIALIZER;
static FILE *log_fp = NULL;

static void log_init(void) {
  const char *home = getenv("HOME");
  if (!home) return;
  char dir[512];
  snprintf(dir, sizeof(dir), "%s/.vakka", home);
  mkdir(dir, 0755);
  char path[512];
  snprintf(path, sizeof(path), "%s/.vakka/egress-audit.ndjson", home);
  log_fp = fopen(path, "a");
  if (log_fp) setvbuf(log_fp, NULL, _IOLBF, 0);
}

static void log_line(const char *fmt, ...) {
  pthread_mutex_lock(&log_mu);
  if (!log_fp) log_init();
  if (log_fp) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    double ts = (double)tv.tv_sec + tv.tv_usec / 1e6;
    fprintf(log_fp, "{\"ts\":%.6f,\"pid\":%d,", ts, getpid());
    va_list ap;
    va_start(ap, fmt);
    vfprintf(log_fp, fmt, ap);
    va_end(ap);
    fputs("}\n", log_fp);
  }
  pthread_mutex_unlock(&log_mu);
}

static void json_escape(char *dst, size_t n, const char *src) {
  if (!src) { snprintf(dst, n, "null"); return; }
  size_t j = 0;
  if (j < n) dst[j++] = '"';
  for (size_t i = 0; src[i] && j + 2 < n; i++) {
    unsigned char c = (unsigned char)src[i];
    if (c == '"' || c == '\\') {
      if (j + 3 >= n) break;
      dst[j++] = '\\'; dst[j++] = c;
    } else if (c < 0x20) {
      if (j + 7 >= n) break;
      j += snprintf(dst + j, n - j, "\\u%04x", c);
    } else {
      dst[j++] = c;
    }
  }
  if (j < n) dst[j++] = '"';
  if (j < n) dst[j] = 0;
  else dst[n - 1] = 0;
}

static void sockaddr_describe(const struct sockaddr *sa, char *ip, size_t ipn, int *port) {
  ip[0] = 0;
  *port = 0;
  if (!sa) return;
  if (sa->sa_family == AF_INET) {
    const struct sockaddr_in *s = (const struct sockaddr_in *)sa;
    inet_ntop(AF_INET, &s->sin_addr, ip, ipn);
    *port = ntohs(s->sin_port);
  } else if (sa->sa_family == AF_INET6) {
    const struct sockaddr_in6 *s = (const struct sockaddr_in6 *)sa;
    inet_ntop(AF_INET6, &s->sin6_addr, ip, ipn);
    *port = ntohs(s->sin6_port);
  }
}

// ---- interposers -----------------------------------------------------------
static int vk_getaddrinfo(const char *hostname, const char *servname,
                          const struct addrinfo *hints, struct addrinfo **res) {
  int rc = getaddrinfo(hostname, servname, hints, res);
  char hbuf[256], sbuf[64];
  json_escape(hbuf, sizeof(hbuf), hostname);
  json_escape(sbuf, sizeof(sbuf), servname);
  log_line("\"event\":\"getaddrinfo\",\"host\":%s,\"serv\":%s,\"rc\":%d", hbuf, sbuf, rc);
  return rc;
}

static int vk_connect(int s, const struct sockaddr *name, socklen_t namelen) {
  char ip[64];
  int port = 0;
  sockaddr_describe(name, ip, sizeof(ip), &port);
  int rc = connect(s, name, namelen);
  int err = (rc < 0) ? errno : 0;
  log_line("\"event\":\"connect\",\"fd\":%d,\"family\":%d,\"ip\":\"%s\",\"port\":%d,\"rc\":%d,\"errno\":%d",
           s, name ? name->sa_family : -1, ip, port, rc, err);
  if (rc < 0) errno = err;
  return rc;
}

DYLD_INTERPOSE(vk_getaddrinfo, getaddrinfo);
DYLD_INTERPOSE(vk_connect, connect);

// ---- constructor -----------------------------------------------------------
__attribute__((constructor))
static void vakka_audit_init(void) {
  log_init();
  log_line("\"event\":\"shim_loaded\",\"shim\":\"audit\",\"v\":1");
}
