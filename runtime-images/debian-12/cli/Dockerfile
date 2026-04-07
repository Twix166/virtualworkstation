FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/home/workstation
ENV TERM=xterm-256color

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    shellinabox \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash workstation

USER workstation
WORKDIR /home/workstation

EXPOSE 7681

CMD ["shellinaboxd", "--disable-ssl", "--disable-ssl-menu", "--no-beep", "--port=7681", "--service=/:workstation:workstation:HOME:SHELL"]
