FROM node:20-alpine

# Criar e definir o diretório de trabalho
WORKDIR /app

# Copiar package.json e package-lock.json
COPY package*.json ./

# Instalar as dependências
RUN npm install

# Copiar os arquivos do projeto
COPY . .

# Fazer o build do TypeScript
RUN npm run build

# Definir o comando para iniciar a aplicação
CMD ["npm", "start"]
