FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:1
ENV HOME=/home/desktop
ENV XDG_RUNTIME_DIR=/run/user/1001
ENV DESKTOP_USER=desktop
ENV DESKTOP_PASSWORD=desktop

RUN apt-get update \
  && apt-get install -y \
    curl \
    dbus \
    dbus-x11 \
    epiphany-browser \
    novnc \
    sudo \
    supervisor \
    tigervnc-standalone-server \
    ubuntu-desktop \
    websockify \
    xfonts-base \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --uid 1001 --create-home --shell /bin/bash "${DESKTOP_USER}" \
  && echo "${DESKTOP_USER}:${DESKTOP_PASSWORD}" | chpasswd \
  && usermod -aG sudo "${DESKTOP_USER}" \
  && printf '%s ALL=(ALL) NOPASSWD:ALL\n' "${DESKTOP_USER}" > /etc/sudoers.d/90-virtualworkstation-desktop \
  && chmod 0440 /etc/sudoers.d/90-virtualworkstation-desktop \
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
