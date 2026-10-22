/* The browser build never opens sockets: requests reach the REST handler
 * in-process through ecs_http_server_request(). These stubs only let the HTTP
 * addon compile; every call fails. */
#ifndef WASI_NET_SHIM_H
#define WASI_NET_SHIM_H
#include <sys/socket.h>
#ifndef SO_RCVTIMEO
#define SO_RCVTIMEO 20
#endif
#ifndef SO_KEEPALIVE
#define SO_KEEPALIVE 9
#endif
#ifndef SO_REUSEADDR
#define SO_REUSEADDR 2
#endif
#ifndef SOMAXCONN
#define SOMAXCONN 128
#endif
#define SIGPIPE 13
#define SIG_IGN ((void (*)(int))1)
int setsockopt(int fd, int level, int name, const void *value, socklen_t len);
int bind(int fd, const struct sockaddr *addr, socklen_t len);
int socket(int domain, int type, int protocol);
int listen(int fd, int backlog);
int getnameinfo(const struct sockaddr *sa, socklen_t salen, char *host, socklen_t hostlen, char *serv, socklen_t servlen, int flags);
#ifndef NI_NUMERICHOST
#define NI_NUMERICHOST 1
#define NI_NUMERICSERV 2
#endif
void (*signal(int sig, void (*handler)(int)))(int);
#endif
