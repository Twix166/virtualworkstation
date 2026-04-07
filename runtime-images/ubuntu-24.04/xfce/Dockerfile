FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:1
ENV HOME=/home/desktop

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    curl \
    dbus-x11 \
    novnc \
    supervisor \
    tigervnc-standalone-server \
    websockify \
    xfce4 \
    xfce4-terminal \
    xfonts-base \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash desktop \
  && mkdir -p /etc/supervisor/conf.d /home/desktop/.vnc /var/log/supervisor \
  && chown -R desktop:desktop /home/desktop /var/log/supervisor

COPY desktop-images/xfce/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY desktop-images/xfce/start-vnc.sh /usr/local/bin/start-vnc.sh
COPY desktop-images/xfce/xstartup /home/desktop/.vnc/xstartup

RUN chmod +x /usr/local/bin/start-vnc.sh /home/desktop/.vnc/xstartup \
  && chown desktop:desktop /usr/local/bin/start-vnc.sh /home/desktop/.vnc/xstartup

USER desktop

EXPOSE 6080 5901

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
