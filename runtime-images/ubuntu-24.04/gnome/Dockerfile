FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:1
ENV HOME=/home/desktop
ENV XDG_RUNTIME_DIR=/run/user/1001

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    curl \
    dbus \
    dbus-x11 \
    gnome-session \
    gnome-shell \
    gnome-terminal \
    novnc \
    supervisor \
    tigervnc-standalone-server \
    ubuntu-session \
    websockify \
    xfonts-base \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash desktop \
  && mkdir -p /etc/supervisor/conf.d /home/desktop/.vnc /var/log/supervisor /run/dbus \
  && chown -R desktop:desktop /home/desktop /var/log/supervisor

COPY runtime-images/ubuntu-24.04/gnome/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY runtime-images/ubuntu-24.04/gnome/prepare-runtime.sh /usr/local/bin/prepare-runtime.sh
COPY desktop-images/xfce/start-vnc.sh /usr/local/bin/start-vnc.sh
COPY runtime-images/ubuntu-24.04/gnome/xstartup /home/desktop/.vnc/xstartup

RUN chmod +x /usr/local/bin/prepare-runtime.sh /usr/local/bin/start-vnc.sh /home/desktop/.vnc/xstartup \
  && chown desktop:desktop /usr/local/bin/start-vnc.sh /home/desktop/.vnc/xstartup

EXPOSE 6080 5901

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
