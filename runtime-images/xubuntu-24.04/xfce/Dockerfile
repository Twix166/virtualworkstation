FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:1
ENV HOME=/home/desktop
ENV DESKTOP_USER=desktop
ENV DESKTOP_PASSWORD=desktop

RUN apt-get update \
  && apt-get install -y \
    curl \
    dbus-x11 \
    novnc \
    sudo \
    supervisor \
    tigervnc-standalone-server \
    websockify \
    xubuntu-desktop \
    xfonts-base \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --uid 1001 --create-home --shell /bin/bash "${DESKTOP_USER}" \
  && echo "${DESKTOP_USER}:${DESKTOP_PASSWORD}" | chpasswd \
  && usermod -aG sudo "${DESKTOP_USER}" \
  && printf '%s ALL=(ALL) NOPASSWD:ALL\n' "${DESKTOP_USER}" > /etc/sudoers.d/90-virtualworkstation-desktop \
  && chmod 0440 /etc/sudoers.d/90-virtualworkstation-desktop \
  && mkdir -p /etc/supervisor/conf.d "/home/${DESKTOP_USER}/.vnc" /var/log/supervisor \
  && chown -R "${DESKTOP_USER}:${DESKTOP_USER}" "/home/${DESKTOP_USER}" /var/log/supervisor

COPY desktop-images/xfce/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY desktop-images/xfce/start-vnc.sh /usr/local/bin/start-vnc.sh
COPY desktop-images/xfce/xstartup /home/desktop/.vnc/xstartup

RUN chmod +x /usr/local/bin/start-vnc.sh /home/desktop/.vnc/xstartup \
  && chown desktop:desktop /usr/local/bin/start-vnc.sh /home/desktop/.vnc/xstartup

USER desktop

EXPOSE 6080 5901

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
