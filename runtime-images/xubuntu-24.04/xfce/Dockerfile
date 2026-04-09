FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:1
ENV HOME=/home/desktop
ENV DESKTOP_USER=desktop
ENV DESKTOP_PASSWORD=desktop
ENV TZ=Etc/UTC
ENV NEEDRESTART_MODE=a
ENV UCF_FORCE_CONFOLD=1

RUN ln -snf "/usr/share/zoneinfo/${TZ}" /etc/localtime \
  && echo "${TZ}" > /etc/timezone \
  && printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d \
  && chmod +x /usr/sbin/policy-rc.d \
  && apt-get update \
  && apt-get install -y --no-install-recommends debconf-utils \
  && printf 'keyboard-configuration keyboard-configuration/layoutcode string us\n' | debconf-set-selections \
  && printf 'keyboard-configuration keyboard-configuration/modelcode string pc105\n' | debconf-set-selections \
  && printf 'console-setup console-setup/charmap47 select UTF-8\n' | debconf-set-selections \
  && printf 'console-setup console-setup/codeset47 select Guess optimal character set\n' | debconf-set-selections \
  && printf 'tzdata tzdata/Areas select Etc\n' | debconf-set-selections \
  && printf 'tzdata tzdata/Zones/Etc select UTC\n' | debconf-set-selections \
  && apt-get install -y \
    curl \
    dbus-x11 \
    epiphany-browser \
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
