const functions = require('firebase-functions');
const admin = require('firebase-admin');
const moment = require('moment');

admin.initializeApp(functions.config().firestore);

// // Create and Deploy Your First Cloud Functions
// // https://firebase.google.com/docs/functions/write-firebase-functions
//
// exports.helloWorld = functions.https.onRequest((request, response) => {
//   functions.logger.info('Hello logs!', {structuredData: true});
//   response.send('Hello from Firebase!');
// });

exports.newTask = functions.firestore
  .document('tasks/{taskId}')
  .onCreate(async (snap) => {
    const newTask = snap.data();
    const userId = newTask.ministry.id;

    const userData = await admin
      .firestore()
      .collection('users')
      .doc(userId)
      .get();

    const user = userData.data();
    const tokens = user.tokens || [];

    let message = `[${newTask.minister.name}] No dia ${moment(newTask.date.toDate()).format('DD/MM/YY')} você tem`;

    if (newTask.functions && newTask.functions.length > 0) {
      message = `${message}${newTask.functions.length > 1 ? ' as funções' : ' a função'}: ${newTask.functions.join(', ')}`;
    } else {
      message = `${message} um compromisso`;
    }

    const notification = {
      title: 'Uma nova escala pra você!',
      body: message,
      type: 'TASK',
    };

    await sendNotification(tokens, notification);
  });

exports.sendDailyNotifications = functions.pubsub
  .schedule('0 3 * * *') // 8 MORNING
  .onRun(async () => {
    const todayStart = moment();
    const todayEnd = moment();
    todayStart.startOf('day');
    todayEnd.endOf('day');

    functions.logger.info(`todayStart: ${todayStart} | todayEnd: ${todayEnd}`);

    const todayTasks = await admin.firestore()
      .collection('tasks')
      .where('date', '>=', todayStart.toDate())
      .where('date', '<=', todayEnd.toDate())
      .get();

    const docs = todayTasks.docs.map((d) => ({ id: d.id, ...d.data() }));
    functions.logger.info(`docs: ${JSON.stringify(docs.map((d) => d.id))}`);

    for await (const doc of docs) {
      const ministry = await admin.firestore()
        .collection('users')
        .doc(doc.ministry.id)
        .get();
      const tokens = ministry.data().tokens || [];

      const notification = {
        title: 'Não se esquece hein!',
        body: `Hoje você está escalado(a) no(a) ${doc.minister.name}`,
        type: 'TASK',
      };

      await sendNotification(tokens, notification);
    }
  });

exports.sendTomorrowNotifications = functions.pubsub
  .schedule('0 3 * * *') // 8 MORNING
  .onRun(async () => {
    const tomorrowStart = moment();
    const tomorrowEnd = moment();
    tomorrowStart.add(1, 'day');
    tomorrowEnd.add(1, 'day');
    tomorrowStart.startOf('day');
    tomorrowEnd.endOf('day');

    functions.logger.info(`todayStart: ${tomorrowStart} | todayEnd: ${tomorrowEnd}`);

    const todayTasks = await admin.firestore()
      .collection('tasks')
      .where('date', '>', tomorrowStart.toDate())
      .where('date', '<', tomorrowEnd.toDate())
      .get();

    for await (const doc of todayTasks.docs.map((d) => ({ id: d.id, ...d.data() }))) {
      const ministry = await admin.firestore()
        .collection('users')
        .doc(doc.ministry.id)
        .get();
      const tokens = ministry.data().tokens || [];

      const notification = {
        title: 'Não se esquece hein!',
        body: `Amanhã você está escalado(a) no(a) ${doc.minister.name}`,
        type: 'TASK',
      };

      await sendNotification(tokens, notification);
    }
  });

exports.newChangeRequest = functions.firestore
  .document('change-requests/{changeRequestId}')
  .onCreate(async (snap) => {
    const newChangeRequest = snap.data();
    const ministerId = newChangeRequest.task.minister.id;

    const notification = {
      title: `${newChangeRequest.task.ministry.name} está precisando de ajuda!`,
      body: `[${newChangeRequest.task.minister.name}] Precisa de troca no dia ${moment(newChangeRequest.task.date.toDate()).format('DD/MM/YY')}.`,
      type: 'CHANGE_REQUEST',
    };

    await sendMessageToPartners(ministerId, newChangeRequest, notification);
  });

exports.deletingTask = functions.firestore
  .document('tasks/{taskId}')
  .onDelete(async (snap) => {
    const taskId = snap.id;

    admin.firestore()
      .collection('change-requests')
      .where('task.id', '==', taskId)
      .get()
      .then((data) => {
        data.docs.forEach((doc) => {
          admin.firestore()
            .collection('change-requests')
            .doc(doc.id)
            .delete();
        });
      });
  });

exports.updateUser = functions.firestore
  .document('users/{userId}')
  .onUpdate(async (snap, context) => {
    const userId = context.params.userId;
    functions.logger.info(`monitor user: ${userId}`);

    const ministersNotification = await checkAndNotifyNewMinister(snap);
    const ministersLeadNotification = await checkAndNotifyNewMinisterLead(snap);

    const user = await getUserById(userId);

    if (user) {
      const tokens = user.tokens;
      functions.logger.info(`send to tokens: ${tokens.toString()}`);

      ministersNotification && await sendNotification(tokens, ministersNotification);
      ministersLeadNotification && await sendNotification(tokens, ministersLeadNotification);
    }
  });

exports.changeRequestNotify = functions.pubsub
  .schedule('0 3 * * *') // 8 MORNING
  .onRun(async () => {
    const pendingChangeRequests = await admin.firestore()
      .collection('change-requests')
      .where('task.date', '>=', admin.firestore.Timestamp.fromDate(moment().startOf('day').toDate()))
      .where('done', '!=', true)
      .get();

    const docs = pendingChangeRequests.docs
      .filter((d) => !d.data().done)
      .map((d) => ({ id: d.id, ...d.data() }))

    functions.logger.info(`pendingChangeRequests: ${JSON.stringify(docs.map((d) => d.id))}`);

    for await (const doc of docs) {
      const notification = {
        title: 'O(A) coleguinha está precisando de ajuda ainda!',
        body: `[${doc.task.minister.name}] Precisa de troca no dia ${moment(doc.task.date.toDate()).format('DD/MM/YY')}.`,
        type: 'CHANGE_REQUEST',
      };

      await sendMessageToPartners(doc.task.minister.id, doc, notification);
    }
  });

exports.updateChurchId = functions.https.onRequest((req, res) => {
  if (!req.query.churchId) {
    res.send({
      error: `The 'churchId' param is required!`,
    });
    return;
  }

  const objs = [];

  admin
    .firestore()
    .collection('tasks')
    .get()
    .then((data) => {
      data.forEach((d) => {
        const obj = { ...d.data() };
        if (!obj.churchId || obj.churchId == null) {
          obj.churchId = req.query.churchId;
        }
        delete obj.churches;

        objs.push(obj);

        admin
          .firestore()
          .collection('tasks')
          .doc(d.id)
          .set(obj)
          .finally(() => functions.logger.info(`update churchId on user: ${obj.name}`));
      });
    })
    .finally(() => res.send(objs));

  return;
});

exports.outagesWeeklyRemember = functions.pubsub
  .schedule('0 3 * * WED') // 8 MORNING EVERY MONDAY
  .onRun(async () => {
    const docs = await admin.firestore()
      .collection('ministers')
      .where('createTaskPeriod', '==', 'WEEKLY')
      .get();
    const ministers = docs.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    functions.logger.info(`${ministers.length} ministers found`);

    for await (const minister of ministers) {
      const users = await admin.firestore()
        .collection('users')
        .where('ministers', 'array-contains', minister.id)
        .get();
      const tokens = users.docs.map((doc) => (doc.data() || []).tokens).flat(2) || [];

      const notification = {
        title: 'Suas indisponibilidades!',
        body: 'Não se esqueça de informar suas indisponibilidades para essa semana',
        type: 'OUTAGES',
      };

      await sendNotification(tokens, notification);
    }
  });

exports.outagesMonthlyRemember = functions.pubsub
  .schedule('0 3 25 * *') // 8 MORNING 25 DAY EVERY MONTH
  .onRun(async () => {
    const docs = await admin.firestore()
      .collection('ministers')
      .where('createTaskPeriod', '==', 'MONTHLY')
      .get();
    const ministers = docs.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    functions.logger.info(`${ministers.length} ministers found`);

    for await (const minister of ministers) {
      const users = await admin.firestore()
        .collection('users')
        .where('ministers', 'array-contains', minister.id)
        .get();
      const tokens = users.docs.map((doc) => (doc.data() || []).tokens).flat(1) || [];

      const notification = {
        title: 'Suas indisponibilidades!',
        body: 'Não se esqueça de informar suas indisponibilidades para o próximo mês',
        type: 'OUTAGES',
      };

      await sendNotification(tokens, notification);
    }
  });

exports.sendManualNotifications = functions.https.onRequest(async (req, res) => {
  const { destination, title, message } = req.query
  const destinationOptions = ['LEADER']

  if (!destinationOptions.includes(destination)) {
    res
      .type('json')
      .send({
        error: 'DESTINATION_NOT_FOUND',
        message: `Destination não encontrado. Opções disponíveis: ${destinationOptions}`
      })
    return;
  }

  switch (destination) {
    case 'LEADER':
      const data = await admin.firestore()
        .collection('users')
        .get()
      const users = data.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(user => user.ministersLead && user.ministersLead.length > 0)
        .map(user => ({ ...user, isLeader: true }))



      res.send({ destination, title, message, users })

      break;

    default:
      break;
  }
})

async function checkAndNotifyNewMinister(snap) {
  const afterMinisters = snap.after.data().ministers;
  const beforeMinisters = snap.before.data().ministers;
  const newMinister = afterMinisters.find((minister) => !beforeMinisters.includes(minister));

  functions.logger.info(`new minister: ${newMinister}`);

  if (newMinister) {
    const minister = await getMinisterById(newMinister);

    if (minister) {
      const notification = {
        title: 'Novo ministério',
        body: `Você acaba de entrar no(a) ${minister.name}.`,
        type: 'UPDATE_USER',
      };

      return notification;
    }
  }

  return undefined;
}

async function checkAndNotifyNewMinisterLead(snap) {
  const afterMinisters = snap.after.data().ministersLead || [];
  const beforeMinisters = snap.before.data().ministersLead || [];
  const newMinister = afterMinisters.find((minister) => !beforeMinisters.includes(minister));
  functions.logger.info(`new ministersLead: ${newMinister}`);

  if (beforeMinisters.length == 0) {
    
  }

  if (newMinister) {
    const minister = await getMinisterById(newMinister);

    if (minister) {
      const notification = {
        title: 'Novo ministério',
        body: `Você acaba de se tornar líder no(a) ${minister.name}.`,
        type: 'UPDATE_USER',
      };

      return notification;
    }
  }

  return undefined;
}

async function getUserById(userId) {
  const user = await admin
    .firestore()
    .collection('users')
    .doc(userId)
    .get();

  if (!user) return undefined;

  return { id: user.id, ...user.data() };
}

async function getMinisterById(newMinister) {
  const minister = await admin
    .firestore()
    .collection('ministers')
    .doc(newMinister)
    .get();

  if (!minister.exists) {
    return undefined;
  }

  return { id: minister.id, ...minister.data() };
}

async function findAndDeleteTokenOnUser(canonicalRegistrationToken) {
  if (canonicalRegistrationToken) {
    const userData = await admin
      .firestore()
      .collection('users')
      .where('tokens', 'array-contains', canonicalRegistrationToken)
      .get();

    if (!userData.empty && userData.docs[0].exists) {
      const tokens = userData.docs[0].data().tokens.filter((token) => token != canonicalRegistrationToken);

      admin
        .firestore()
        .collection('users')
        .doc(userData.docs[0].id)
        .update({ tokens });
    }
  }
}

async function sendNotification(tokens, notification) {
  functions.logger.info(`send notification: ${JSON.stringify({ tokens, notification })}`);

  const notificationResult = await admin
    .messaging()
    .sendToDevice(tokens, {
      notification: {
        title: notification.title,
        body: notification.body,
      },
      data: { type: notification.type },
    });

  notificationResult.results.forEach((r) => {
    if (r.error) {
      functions.logger.error('An ocurred error', r.error.message);

      if (r.error.message.includes('The provided registration token is not registered')) {
        functions.logger.error('Token unregisterd', r.error.stack);
        findAndDeleteTokenOnUser(r.canonicalRegistrationToken);
      }
    }
  });
}

async function sendMessageToPartners(ministerId, changeRequest, notification) {
  const ministerData = await admin
    .firestore()
    .collection('ministers')
    .doc(ministerId)
    .get();
  const minister = ministerData.data();

  functions.logger.info(`check users from ministerId: ${ministerId}`);

  const targetField = (minister.changesFree || minister.changesFree == undefined) ? 'ministers' : 'ministersLead';
  const usersData = await admin
    .firestore()
    .collection('users')
    .where(targetField, 'array-contains', ministerId)
    .get();

  if (!usersData) return;

  const usersFound = usersData.docs
    .filter((d) => d.id != changeRequest.task.ministry.id)
    .map((d) => d.data());
  functions.logger.info(`users found: ${JSON.stringify(usersFound.map((user) => user.id))}`);

  let tokens = usersFound.map((d) => d.tokens) || [];
  tokens = tokens.flat(2);

  await sendNotification(tokens, notification);
}