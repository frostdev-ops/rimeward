/** WebRTC media never goes through conversation storage or the native JSON bridge. */
export function remoteMedia(video: HTMLVideoElement, action: (body: Record<string, unknown>) => Promise<Response>, fallback: (error: unknown) => void, unavailable: (capability: string, reason: string) => void) {
  let peer: RTCPeerConnection | undefined, channel: RTCDataChannel | undefined, revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { revision++; clearTimeout(timer); channel?.close(); channel = undefined; peer?.close(); peer = undefined; video.srcObject = null; video.hidden = true; };
  const start = async (quality: unknown, audio: boolean, forceTurn = false) => {
    stop(); const current = revision;
    const call = async (body: Record<string, unknown>) => {
      if (current !== revision) throw new DOMException('Media session changed.', 'AbortError');
      const result = await action(body).then(response => response.json()).catch(error => {
        if (current !== revision) throw new DOMException('Media session changed.', 'AbortError');
        throw error;
      });
      if (current !== revision) throw new DOMException('Media session changed.', 'AbortError');
      return result;
    };
    const options = await call({ command: 'start', quality, audio, forceTurn });
    const connection = new RTCPeerConnection({ iceServers: options.iceServers, iceTransportPolicy: forceTurn ? 'relay' : 'all' }); peer = connection;
    video.muted = !audio;
    const stream = new MediaStream(); video.srcObject = stream;
    const candidates: RTCIceCandidateInit[] = [];
    let failed = false;
    const fail = (error: unknown) => {
      if (current !== revision || failed) return; failed = true; stop();
      void action({ command: 'stop', failure: true }).catch(() => {}); fallback(error);
    };
    connection.ontrack = event => { if (current !== revision) return; stream.addTrack(event.track); video.hidden = false; void video.play().catch(fail); };
    connection.ondatachannel = event => {
      if (current !== revision || event.channel.label !== 'rimeward-input-v1') { event.channel.close(); return; }
      channel = event.channel;
    };
    connection.onicecandidate = event => {
      if (event.candidate) void call({ command: 'ice', candidate: event.candidate.candidate, sdpMLineIndex: event.candidate.sdpMLineIndex }).catch(fail);
    };
    connection.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(connection.connectionState)) fail(Error('WebRTC connection ended. Compatibility mode is available.'));
    };
    const began = Date.now();
    let reportedAt = began;
    const poll = async () => {
      if (current !== revision) return;
      try {
        const result = await call({ command: 'poll' });
        for (const event of result.events ?? []) {
          if (current !== revision) return;
          if (event.event === 'sdp') {
            if (connection.remoteDescription) throw Error('Unexpected second offer. Reconnect viewing.');
            await connection.setRemoteDescription({ type: 'offer', sdp: event.sdp });
            const answer = await connection.createAnswer(); await connection.setLocalDescription(answer);
            await call({ command: 'answer', sdp: answer.sdp });
            for (const candidate of candidates.splice(0)) await connection.addIceCandidate(candidate);
          } else if (event.event === 'ice') {
            const candidate = { candidate: event.candidate, sdpMLineIndex: event.sdpMLineIndex, sdpMid: event.sdpMid };
            if (connection.remoteDescription) await connection.addIceCandidate(candidate); else candidates.push(candidate);
          } else if (event.event === 'capability-unavailable') unavailable(event.capability, event.reason);
          else if (event.event === 'error' || event.event === 'closed' || event.event === 'input-rejected') throw Error(event.reason ?? 'Media ended.');
        }
        if (Date.now() - began > 15000 && connection.connectionState !== 'connected') throw Error('Direct WebRTC and TURN could not connect.');
        if (connection.connectionState === 'connected' && Date.now() - reportedAt >= 10000) {
          reportedAt = Date.now();
          const stats = await mediaStats(connection);
          if (current !== revision) return;
          // Optional diagnostics cannot terminate an otherwise healthy media session.
          await call({ command: 'metrics', mediaId: options.mediaId, transport: stats.transport, bytes: stats.bytes, rtt: stats.rtt }).catch(() => {});
        }
        if (current !== revision) return;
        timer = setTimeout(() => void poll(), connection.connectionState === 'connected' ? 2000 : 150);
      } catch (error) { fail(error); }
    };
    void poll();
  };
  return {
    start, stop,
    connected: () => peer?.connectionState === 'connected',
    send: (body: Record<string, unknown>) => {
      if (channel?.readyState !== 'open') return false;
      if (channel.bufferedAmount > 64 * 1024) throw Error('Input channel is backed up. Release and acquire control again.');
      channel.send(JSON.stringify(body)); return true;
    },
    /** transport, rtt ms, fps and cumulative bytes received — the ward diffs bytes for a bitrate. */
    stats: async () => peer ? mediaStats(peer) : null,
  };
}
async function mediaStats(peer: RTCPeerConnection) {
  const report = await peer.getStats(); let transport = 'webrtc', rtt = 0, frames = 0, bytes = 0;
  report.forEach(item => {
    if (item.type === 'candidate-pair' && item.state === 'succeeded' && item.nominated) {
      if (report.get(item.localCandidateId)?.candidateType === 'relay' || report.get(item.remoteCandidateId)?.candidateType === 'relay') transport = 'turn';
      rtt = Math.round((item.currentRoundTripTime ?? 0) * 1000);
    }
    if (item.type === 'inbound-rtp') {
      bytes += item.bytesReceived ?? 0;
      if (item.kind === 'video') frames = Math.round(item.framesPerSecond ?? 0);
    }
  });
  return { transport, rtt, frames, bytes };
}
