export default {
  async fetch(request, env, ctx) {
    // 处理WebSocket连接
    if (request.headers.get('Upgrade') === 'websocket') {
      const url = new URL(request.url);
      const userId = url.searchParams.get('id'); // 客人/主人的ID
      const role = url.searchParams.get('role'); // 'guest'或'i'
      const pwd = url.searchParams.get('pwd'); // 主人的密码
      
      if (!userId || !role) {
        return new Response('缺少ID或角色参数', { status: 400 });
      }

      // 创建WebSocket连接对
      const { 0: clientWs, 1: serverWs } = new WebSocketPair();
      // 处理服务器端WebSocket逻辑（绑定4个KV）
      await handleWebSocket(
        serverWs, userId, role, pwd,
        env.MSGS_KV,        // 离线消息
        env.PWDS_KV,        // 主人密码
        env.ALLOWED_KV,     // 已允许客人
        env.PENDING_KV      // 待验证客人
      );
      
      return new Response(null, {
        status: 101,
        webSocket: clientWs
      });
    }

    return new Response('信令服务器运行中', { status: 200 });
  }
};

async function handleWebSocket(ws, userId, role, pwd, msgsKV, pwdsKV, allowedKV, pendingKV) {
  const onlineUsers = new Map();
  onlineUsers.set(userId, { ws, role });

  // 主人登录验证
  if (role === 'i' && pwd) {
    const storedPwd = await pwdsKV.get(userId);
    if (!storedPwd) {
      await pwdsKV.put(userId, pwd); // 首次登录保存密码
    } else if (storedPwd !== pwd) {
      ws.send(JSON.stringify({ type: 'loginFail', reason: '密码错误' }));
      ws.close(1008, '密码错误');
      return;
    }
  }

  // 主人上线：加载离线消息和权限列表
  if (role === 'i') {
    // 加载离线消息
    const offlineMsgs = await msgsKV.get(userId) || '[]';
    ws.send(JSON.stringify({
      type: 'offlineMessages',
      messages: JSON.parse(offlineMsgs)
    }));
    await msgsKV.delete(userId);

    // 加载权限列表
    const allowed = JSON.parse(await allowedKV.get(userId) || '[]');
    const pending = JSON.parse(await pendingKV.get(userId) || '[]');
    ws.send(JSON.stringify({
      type: 'permissionsList',
      allowed: allowed,
      pending: pending
    }));
  }

  // 处理消息
  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      const hostId = role === 'guest' ? data.to : userId; // 主人ID

      // 1. 客人发送验证请求（首次消息）
      if (data.type === 'verifyRequest' && role === 'guest') {
        const allowed = JSON.parse(await allowedKV.get(hostId) || '[]');
        const pending = JSON.parse(await pendingKV.get(hostId) || '[]');
        const isAllowed = allowed.some(g => g.id === data.guestId);
        const isPending = pending.some(g => g.id === data.guestId);

        if (isAllowed) {
          // 已允许，直接转发
          const hostWs = onlineUsers.get(hostId)?.ws;
          hostWs && hostWs.send(JSON.stringify({
            type: 'message',
            from: data.from,
            guestId: data.guestId,
            content: data.content,
            time: data.time
          }));
        } else if (!isPending) {
          // 新增到待验证列表，通知主人
          pending.push({ id: data.guestId, nickname: data.from });
          await pendingKV.put(hostId, JSON.stringify(pending));
          const hostWs = onlineUsers.get(hostId)?.ws;
          hostWs && hostWs.send(JSON.stringify({
            type: 'verifyRequest',
            guestId: data.guestId,
            from: data.from,
            content: data.content,
            time: data.time
          }));
          // 刷新主人权限列表
          hostWs && hostWs.send(JSON.stringify({
            type: 'permissionsList',
            allowed: allowed,
            pending: pending
          }));
        }
      }

      // 2. 主人允许客人
      else if (data.type === 'allowGuest' && role === 'i') {
        const allowed = JSON.parse(await allowedKV.get(hostId) || '[]');
        const pending = JSON.parse(await pendingKV.get(hostId) || '[]');
        // 添加到允许列表，从待验证移除
        allowed.push({ id: data.guestId, nickname: data.nickname });
        const updatedPending = pending.filter(g => g.id !== data.guestId);
        await allowedKV.put(hostId, JSON.stringify(allowed));
        await pendingKV.put(hostId, JSON.stringify(updatedPending));
        // 通知主人刷新列表
        ws.send(JSON.stringify({
          type: 'permissionsList',
          allowed: allowed,
          pending: updatedPending
        }));
        // 通知客人验证通过
        const guestWs = Array.from(onlineUsers.values())
          .find(u => u.role === 'guest' && u.ws !== ws)?.ws;
        guestWs && guestWs.send(JSON.stringify({ type: 'verifyPass' }));
      }

      // 3. 主人禁止客人
      else if (data.type === 'rejectGuest' && role === 'i') {
        const pending = JSON.parse(await pendingKV.get(hostId) || '[]');
        const updatedPending = pending.filter(g => g.id !== data.guestId);
        await pendingKV.put(hostId, JSON.stringify(updatedPending));
        // 通知主人刷新
        ws.send(JSON.stringify({
          type: 'permissionsList',
          allowed: JSON.parse(await allowedKV.get(hostId) || '[]'),
          pending: updatedPending
        }));
        // 通知客人被拒绝
        const guestWs = Array.from(onlineUsers.values())
          .find(u => u.role === 'guest' && u.ws !== ws)?.ws;
        guestWs && guestWs.send(JSON.stringify({ type: 'verifyReject' }));
      }

      // 4. 主人移除已允许的客人
      else if (data.type === 'removeGuest' && role === 'i') {
        const allowed = JSON.parse(await allowedKV.get(hostId) || '[]');
        const updatedAllowed = allowed.filter(g => g.id !== data.guestId);
        await allowedKV.put(hostId, JSON.stringify(updatedAllowed));
        ws.send(JSON.stringify({
          type: 'permissionsList',
          allowed: updatedAllowed,
          pending: JSON.parse(await pendingKV.get(hostId) || '[]')
        }));
      }

      // 5. 已验证客人发送消息
      else if (data.type === 'message' && role === 'guest') {
        const allowed = JSON.parse(await allowedKV.get(hostId) || '[]');
        if (allowed.some(g => g.id === data.guestId)) {
          // 已允许，转发给主人
          const hostWs = onlineUsers.get(hostId)?.ws;
          if (hostWs) {
            hostWs.send(JSON.stringify({
              type: 'message',
              from: data.from,
              guestId: data.guestId,
              content: data.content,
              time: data.time
            }));
          } else {
            // 主人离线，存储消息
            const existingMsgs = await msgsKV.get(hostId) || '[]';
            const msgs = JSON.parse(existingMsgs);
            msgs.push({ ...data, from: data.from });
            await msgsKV.put(hostId, JSON.stringify(msgs));
          }
        }
      }

      // 6. 主人回复消息
      else if (data.type === 'message' && role === 'i') {
        if (data.to) {
          // 回复特定客人
          const guestWs = onlineUsers.get(data.to)?.ws;
          guestWs && guestWs.send(JSON.stringify({
            type: 'message',
            from: 'i',
            content: data.content,
            time: data.time
          }));
        } else {
          // 广播给所有在线客人
          onlineUsers.forEach((user) => {
            if (user.role === 'guest') {
              user.ws.send(JSON.stringify({
                type: 'message',
                from: 'i',
                content: data.content,
                time: data.time
              }));
            }
          });
        }
      }

    } catch (err) {
      console.error('消息处理错误:', err);
      ws.send(JSON.stringify({ type: 'error', message: '消息格式错误' }));
    }
  };

  // 连接关闭
  ws.onclose = () => {
    onlineUsers.delete(userId);
  };

  ws.onerror = (err) => {
    console.error('WebSocket错误:', err);
  };
}


